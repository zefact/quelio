//! CSV/TSVファイルの取り込み。
//!
//! 全体を1つのトランザクションで包み、
//! 途中で失敗・中止したときは何も入っていない状態へ戻す。
//! 手順が長く、後始末の分岐も多いので独立させている

use super::*;

/// CSV/TSVファイルをテーブルへ取り込む。
///
/// 全体を1つのトランザクションで包む。
/// 途中で失敗・中止したときは何も入っていない状態へ戻す
/// (半端に入ると、どこまで入ったか分からず後始末が難しいため)
#[allow(clippy::too_many_arguments)]
pub async fn import_csv(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: Option<String>,
    schema: Option<String>,
    table: &str,
    path: &std::path::Path,
    opts: &crate::csv_import::CsvOptions,
    // mapping: (CSVの何列目か, 取り込み先のカラム名)
    mapping: &[(usize, String)],
    mode: crate::csv_import::ImportMode,
    empty_as_null: bool,
    job: Option<&crate::csv_job::CsvJob>,
) -> Result<crate::csv_import::ImportResult, String> {
    use crate::csv_import::{build_insert, safe_cast_type, ImportMode, RowReader, TargetColumn};

    if mapping.is_empty() {
        return Err("取り込む列を1つ以上選んでください".into());
    }

    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_writable(session)?;
    ensure_alive(session, qlog).await?;
    // ここから先は接続を握っている。サーバーへ中止を送っても、無関係なSQLを止めることはない
    if let Some(j) = job {
        j.mark_running();
    }
    if matches!(session.conn, DbConn::Kv(_)) {
        return Err("Valkey接続ではこの操作はできません".into());
    }
    let db_type = session.profile.db_type;
    let label = conn_label(&session.profile);
    let db_label = database.clone().unwrap_or_default();
    ensure_database(session, database.as_ref(), qlog, &label).await?;

    let ctx = LogCtx {
        qlog,
        connection: &label,
        database: &db_label,
    };

    /*
     * 取り込み先の列は、画面から来た名前をそのまま使わずカタログで確かめる。
     * 型 (PostgreSQLのキャスト用) と主キー (重複時の判定用) もここで拾う
     */
    let schema_name = schema.clone().unwrap_or_default();
    let detail = match &mut session.conn {
        DbConn::MySql(conn) => {
            let db = database.clone().unwrap_or_default();
            catalog::mysql_table_detail(conn, &db, table, &ctx).await?
        }
        DbConn::Pg(conn) => {
            let sc = if schema_name.is_empty() {
                "public".to_string()
            } else {
                schema_name.clone()
            };
            catalog::pg_table_detail(conn, &sc, table, &ctx).await?
        }
        DbConn::Sqlite(conn) => catalog::sqlite_table_detail(conn, table, &ctx).await?,
        DbConn::Kv(_) => unreachable!(),
    };

    let mut cols: Vec<TargetColumn> = Vec::with_capacity(mapping.len());
    let mut indexes: Vec<usize> = Vec::with_capacity(mapping.len());
    for (csv_index, name) in mapping {
        let Some(col) = detail.columns.iter().find(|c| &c.name == name) else {
            return Err(format!("カラム '{name}' がテーブルにありません"));
        };
        // 同じ列を2回入れるとSQLが壊れるので、ここで弾く
        if cols.iter().any(|c| c.name == col.name) {
            return Err(format!("カラム '{}' を2回選んでいます", col.name));
        }
        let cast_type = if db_type == DbType::Postgresql && safe_cast_type(&col.col_type) {
            Some(col.col_type.clone())
        } else {
            None
        };
        cols.push(TargetColumn {
            name: col.name.clone(),
            cast_type,
        });
        indexes.push(*csv_index);
    }

    /*
     * 1行ぶんでもプレースホルダの上限を超えるほど列が多いと、どうやっても送れない。
     * 分かりにくいDBのエラーになる前にここで断る
     */
    if cols.len() > crate::csv_import::max_params(db_type) {
        return Err(format!(
            "一度に取り込める列は{}個までです",
            crate::csv_import::max_params(db_type)
        ));
    }

    // 重複時に上書きする列を決めるための主キー (PostgreSQL・SQLiteで使う)
    let pk: Vec<String> = detail
        .columns
        .iter()
        .filter(|c| c.key.as_deref() == Some("PRI"))
        .map(|c| c.name.clone())
        .collect();
    /*
     * PostgreSQLとSQLiteの「重複は上書き」は ON CONFLICT (列) の形なので、
     * どの列で重複を判定するかが分からないと書けない
     */
    if matches!(db_type, DbType::Postgresql | DbType::Sqlite)
        && mode == ImportMode::Replace
        && pk.is_empty()
    {
        return Err(
            "主キーが無いテーブルでは「重複は上書き」を使えません (追加か、重複は飛ばすを選んでください)"
                .into(),
        );
    }

    /*
     * PostgreSQLでスキーマの指定が無いとき、列の定義は public から取っている。
     * INSERT先を修飾しないと search_path 次第で別のテーブルへ入りかねないので、
     * 定義を取ったのと同じスキーマを明示する
     */
    let table_schema = if db_type == DbType::Postgresql && schema_name.is_empty() {
        Some("public")
    } else {
        schema.as_deref()
    };
    let table_sql = crate::ddl::quote_table(db_type, table_schema, table);
    /*
     * 主キーが取り込む列の何番目にあるか (重複した行をまとめるのに使う)。
     * 主キーの一部しか取り込まないときは重複かどうかを決められないので、
     * 全部そろっているときだけ使う
     */
    let pk_positions: Vec<usize> = cols
        .iter()
        .enumerate()
        .filter(|(_, c)| pk.contains(&c.name))
        .map(|(at, _)| at)
        .collect();
    let can_dedupe = !pk.is_empty() && pk_positions.len() == pk.len();
    let mut reader = RowReader::new(path, opts, indexes, empty_as_null)?;

    begin_txn(session, qlog, &label, &db_label, begin_sql(&session.conn)).await?;
    qlog.add(
        &label,
        &db_label,
        &format!("-- CSV取り込み開始 {table_sql} ({}列)", cols.len()),
    );

    let batch = crate::csv_import::batch_rows(db_type, cols.len());
    let mut done = 0usize;
    // 読んだ行数 (取り込んだ行数とは別。エラーの行番号に使う)
    let mut read_rows = 0usize;
    let mut cancelled = false;
    /*
     * 1バッチぶんのSQLは行数が同じなら使い回せる。
     * 毎回組み立て直すと、行数ぶんの文字列結合が繰り返し走る
     */
    let full_sql = build_insert(db_type, &table_sql, &cols, batch, mode, &pk);

    loop {
        if job.is_some_and(|j| j.is_cancelled()) {
            cancelled = true;
            break;
        }
        let mut params: Vec<Option<String>> = Vec::with_capacity(batch * cols.len());
        let mut rows_in_batch = 0usize;
        while rows_in_batch < batch {
            match reader.next_row() {
                Ok(Some(row)) => {
                    // 上限は読んだ時点で見る (INSERTしてから戻すのは無駄が大きい)
                    if done + rows_in_batch >= crate::csv_import::MAX_ROWS {
                        let _ = end_txn(session, qlog, &label, &db_label, false).await;
                        return Err(format!(
                            "行数が上限 ({}行) を超えました。ファイルを分けてください",
                            crate::csv_import::fmt_count(crate::csv_import::MAX_ROWS)
                        ));
                    }
                    params.extend(row);
                    rows_in_batch += 1;
                    read_rows += 1;
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = end_txn(session, qlog, &label, &db_label, false).await;
                    return Err(format!(
                        "{}行目付近で読み取れませんでした: {e}",
                        read_rows + 1
                    ));
                }
            }
        }
        if rows_in_batch == 0 {
            break;
        }

        /*
         * PostgreSQLは1つのINSERTで同じ行を2回更新できない。
         * CSVの中に同じ主キーの行があるとその文ごと失敗するので、
         * 他のDBと同じ「後の行が勝つ」に揃えてからまとめて送る
         */
        if db_type == DbType::Postgresql && mode == ImportMode::Replace && can_dedupe {
            rows_in_batch =
                crate::csv_import::dedupe_rows(&mut params, cols.len(), &pk_positions);
        }

        let sql = if rows_in_batch == batch {
            full_sql.clone()
        } else {
            build_insert(db_type, &table_sql, &cols, rows_in_batch, mode, &pk)
        };
        // 1件ずつログに出すと履歴が埋まるので、最初の1回だけ形を残す
        if done == 0 {
            qlog.add(&label, &db_label, &sql);
        }
        if let Err(e) = exec_bound_quiet(&mut session.conn, &sql, &params).await {
            /*
             * 「中止」を押すとサーバー側からも1本を止めに行くので、
             * その結果のエラーが先に返ってくる。失敗として報告しない
             */
            if job.is_some_and(|j| j.is_cancelled()) {
                cancelled = true;
                break;
            }
            mark_rolling_back(job);
            let note = rollback_note(session, qlog, &label, &db_label).await;
            return Err(format!(
                "{}行目までの取り込みに失敗しました: {e}
{note}
(同じ主キーの行がファイルの中にある場合もこの形で失敗します)",
                read_rows
            ));
        }
        done += rows_in_batch;
        if let Some(j) = job {
            j.set_rows(done);
        }
    }

    /*
     * 最後のバッチを読み終えてからここまでの間に切断されることがある。
     * COMMITは時間がかかる (fsyncやレプリカ待ち) ので、その直前でもう一度見る
     */
    if job.is_some_and(|j| j.is_cancelled()) {
        cancelled = true;
    }
    end_txn(session, qlog, &label, &db_label, !cancelled).await?;
    qlog.add(
        &label,
        &db_label,
        &format!(
            "-- CSV取り込み{} {done}行",
            if cancelled { "中止" } else { "完了" }
        ),
    );
    Ok(crate::csv_import::ImportResult {
        rows: if cancelled { 0 } else { done },
        cancelled,
    })
}

/// 取り消しに入ったことを進捗に出す (ジョブが無いときは何もしない)
pub(super) fn mark_rolling_back(job: Option<&crate::csv_job::CsvJob>) {
    if let Some(j) = job {
        j.set_phase(crate::csv_job::JobPhase::RollingBack);
    }
}

/// 値を渡してSQLを実行する (ログに出さない版。CSV取り込みのように何度も呼ぶ用)
pub(super) async fn exec_bound_quiet(
    conn: &mut DbConn,
    sql: &str,
    params: &[Option<String>],
) -> Result<u64, String> {
    // SQLは自前で組み立てた固定の形 (値はすべてプレースホルダ) なので安全
    let safe = sqlx::AssertSqlSafe(sql.to_string());
    with_sql_conn!(conn, "Valkey接続ではSQLは実行できません", |c| {
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
