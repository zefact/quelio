//! 1行・1セル単位の読み書き。
//!
//! データタブの編集は、SQLをそのまま実行するのとは危険度が違う。
//! 主キーで1行だけを指すこと・値をプレースホルダで渡すことを
//! ここで守り、組み立てた文字列をそのまま流さないようにしている

use super::*;

/// プレースホルダに値を渡してSQLを1つ実行し、影響した行数を返す
async fn exec_bound(
    conn: &mut DbConn,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
    sql: &str,
    params: &[Option<String>],
) -> Result<u64, String> {
    qlog.add(label, db_label, sql);
    // SQLは自前で組み立てた固定の形 (値はすべてプレースホルダ) なので安全
    let safe = sqlx::AssertSqlSafe(sql.to_string());
    with_sql_conn!(conn, "Valkey接続では使用できません", |c| {
        let mut q = sqlx::query(safe);
        for p in params {
            q = q.bind(p.clone());
        }
        q.execute(&mut *c)
            .await
            .map(|r| r.rows_affected())
            .map_err(db::format_db_error)
    })
}

/// 1セルの値を切り詰めずに読み直す (画面では長い値を切り詰めているため)。
/// 主キーで1行に絞った SELECT を1本だけ発行する
pub async fn fetch_cell(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: Option<String>,
    schema: Option<String>,
    table: &str,
    column: &str,
    key: &[crate::dml::Cell],
    timeout_secs: u64,
) -> Result<CellValue, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    let db_type = session.profile.db_type;
    if matches!(session.conn, DbConn::Kv(_)) {
        return Err("Valkey接続ではこの操作はできません".into());
    }
    let label = conn_label(&session.profile);
    let db_label = database.clone().unwrap_or_default();
    ensure_database(session, database.as_ref(), qlog, &label).await?;

    // PostgreSQLは主キーの値のキャストにカラム型が要る
    let mut types: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if let DbConn::Pg(conn) = &mut session.conn {
        let schema_name = schema.clone().unwrap_or_else(|| "public".to_string());
        for (name, t) in catalog::pg_column_types(conn, &schema_name, table).await? {
            types.insert(name, t);
        }
    }

    let (sql, params) =
        crate::dml::build_cell_select(db_type, schema.as_deref(), table, column, key, &types)?;
    // 応答が返らないとタブ全体が止まるため、実行と同じタイムアウトを掛ける
    tokio::time::timeout(
        query::query_timeout(timeout_secs),
        fetch_bound_cell(&mut session.conn, qlog, &label, &db_label, &sql, &params),
    )
    .await
    .map_err(|_| crate::apperr::timeout_message("セルの取得"))?
}

/// テーブルの正確な行数を数える (一覧に出している概算との差を確かめるため)。
/// 大きな表では時間が掛かるので、実行と同じタイムアウトを掛ける
pub async fn count_table_rows(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: Option<String>,
    schema: Option<String>,
    table: &str,
    timeout_secs: u64,
) -> Result<i64, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    let db_type = session.profile.db_type;
    let label = conn_label(&session.profile);
    let db_label = database.clone().unwrap_or_default();
    ensure_database(session, database.as_ref(), qlog, &label).await?;
    let sql = crate::dml::build_table_count(db_type, schema.as_deref(), table)?;
    tokio::time::timeout(
        query::query_timeout(timeout_secs),
        fetch_bound_count(&mut session.conn, qlog, &label, &db_label, &sql, &[]),
    )
    .await
    .map_err(|_| crate::apperr::timeout_message("件数の取得"))?
}

/// 1セルの取得結果 (行が無い場合と値がNULLの場合を区別する)
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellValue {
    /// 対象の行が見つかったか
    pub found: bool,
    /// 値 (NULLならNone)
    pub value: Option<String>,
}

/// 1行1列のSELECT (COUNT) を実行して件数を返す
async fn fetch_bound_count(
    conn: &mut DbConn,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
    sql: &str,
    params: &[Option<String>],
) -> Result<i64, String> {
    qlog.add(label, db_label, sql);
    // SQLは自前で組み立てた固定の形 (値はすべてプレースホルダ) なので安全
    let safe = sqlx::AssertSqlSafe(sql.to_string());
    with_sql_conn!(conn, "Valkey接続では使用できません", |c| {
        let mut q = sqlx::query_scalar::<_, i64>(safe);
        for p in params {
            q = q.bind(p.clone());
        }
        q.fetch_one(&mut *c).await.map_err(db::format_db_error)
    })
}

/// 1行1列のSELECTを実行し、その値を (上限まで) 切り詰めずに返す
async fn fetch_bound_cell(
    conn: &mut DbConn,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
    sql: &str,
    params: &[Option<String>],
) -> Result<CellValue, String> {
    qlog.add(label, db_label, sql);
    // SQLは自前で組み立てた固定の形 (値はすべてプレースホルダ) なので安全
    let safe = sqlx::AssertSqlSafe(sql.to_string());
    match conn {
        DbConn::MySql(c) => {
            let mut q = sqlx::query(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            let row = q
                .fetch_optional(&mut *c)
                .await
                .map_err(db::format_db_error)?;
            Ok(CellValue {
                found: row.is_some(),
                value: row.and_then(|r| query::mysql_cell_fetch(&r)),
            })
        }
        DbConn::Pg(c) => {
            let mut q = sqlx::query(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            let row = q
                .fetch_optional(&mut *c)
                .await
                .map_err(db::format_db_error)?;
            Ok(CellValue {
                found: row.is_some(),
                value: row.and_then(|r| query::pg_cell_fetch(&r)),
            })
        }
        DbConn::Sqlite(c) => {
            let mut q = sqlx::query(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            let row = q
                .fetch_optional(&mut *c)
                .await
                .map_err(db::format_db_error)?;
            Ok(CellValue {
                found: row.is_some(),
                value: row.and_then(|r| query::sqlite_cell_fetch(&r)),
            })
        }
        DbConn::Kv(_) => Err("Valkey接続では使用できません".into()),
    }
}

/// データの1行を追加・更新・削除する。
///
/// 主キーの指定ミスなどで意図せず複数行に当たると取り返しがつかないため、
/// トランザクションで包み、影響行数がちょうど1行でなければ取り消す
pub async fn apply_row_change(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: Option<String>,
    schema: Option<String>,
    table: &str,
    change: &crate::dml::RowChange,
) -> Result<String, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_writable(session)?;
    ensure_alive(session, qlog).await?;
    let db_type = session.profile.db_type;
    if matches!(session.conn, DbConn::Kv(_)) {
        return Err("Valkey接続ではこの操作はできません".into());
    }
    let label = conn_label(&session.profile);
    let db_label = database.clone().unwrap_or_default();
    ensure_database(session, database.as_ref(), qlog, &label).await?;

    // PostgreSQLは値のキャストにカラム型が要る
    let mut types: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if let DbConn::Pg(conn) = &mut session.conn {
        let schema_name = schema.clone().unwrap_or_else(|| "public".to_string());
        for (name, t) in catalog::pg_column_types(conn, &schema_name, table).await? {
            types.insert(name, t);
        }
    }

    let (sql, params) =
        crate::dml::build(db_type, schema.as_deref(), table, change, &types)?;

    begin_txn(session, qlog, &label, &db_label, begin_sql(&session.conn)).await?;

    /*
     * 実行前に、キーで特定できる行がちょうど1行かを数える。
     *
     * 実行後の影響行数だけで判断すると、MySQLでは「値が変わらなかった更新」が
     * 0行として返るため、正しい変更まで取り消してしまう
     */
    let mut count_query: Option<(String, Vec<Option<String>>)> = None;
    if let Some(key) = change.key() {
        let built =
            match crate::dml::build_key_count(db_type, schema.as_deref(), table, key, &types) {
                Ok(v) => v,
                Err(e) => {
                    let _ = end_txn(session, qlog, &label, &db_label, false).await;
                    return Err(e);
                }
            };
        let found = match fetch_bound_count(
            &mut session.conn,
            qlog,
            &label,
            &db_label,
            &built.0,
            &built.1,
        )
        .await
        {
            Ok(n) => n,
            Err(e) => {
                let _ = end_txn(session, qlog, &label, &db_label, false).await;
                return Err(e);
            }
        };
        if found != 1 {
            let note = rollback_note(session, qlog, &label, &db_label).await;
            return Err(format!(
                "対象が1行になりませんでした ({found}行)\n{note}一覧を再読み込みしてください"
            ));
        }
        count_query = Some(built);
    }

    let affected = match exec_bound(
        &mut session.conn,
        qlog,
        &label,
        &db_label,
        &sql,
        &params,
    )
    .await
    {
        Ok(n) => n,
        Err(e) => {
            let _ = end_txn(session, qlog, &label, &db_label, false).await;
            return Err(e);
        }
    };
    /*
     * 影響行数の確認。
     * 更新は「値が同じで0行」があり得るので、2行以上のときだけ取り消す
     * (1行であることは上で数えて確かめている)
     */
    let update = matches!(change, crate::dml::RowChange::Update { .. });
    if if update { affected > 1 } else { affected != 1 } {
        let note = rollback_note(session, qlog, &label, &db_label).await;
        return Err(format!(
            "対象が1行になりませんでした ({affected}行)\n{note}一覧を再読み込みしてください"
        ));
    }
    /*
     * 更新で0行だったときは「値が同じ」か「行が消えた」かの区別が付かないため、
     * もう一度数えて行がまだあることを確かめる
     */
    if update && affected == 0 {
        if let Some((count_sql, count_params)) = &count_query {
            let still = fetch_bound_count(
                &mut session.conn,
                qlog,
                &label,
                &db_label,
                count_sql,
                count_params,
            )
            .await
            .unwrap_or(0);
            if still != 1 {
                let note = rollback_note(session, qlog, &label, &db_label).await;
                return Err(format!(
                    "対象の行が見つかりませんでした\n{note}一覧を再読み込みしてください"
                ));
            }
        }
    }
    end_txn(session, qlog, &label, &db_label, true).await?;
    Ok(sql)
}
