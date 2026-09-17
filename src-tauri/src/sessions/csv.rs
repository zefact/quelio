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
    use crate::csv_import::{
        build_insert, safe_cast_type, ImportMode, RowMeta, RowReader, TargetColumn,
    };

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
    /*
     * 失敗したときに「どの列が型に合わないか」を推定するため、
     * 取り込み先の型名を同じ並びで控えておく
     */
    let mut col_types: Vec<String> = Vec::with_capacity(mapping.len());
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
        col_types.push(col.col_type.clone());
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
    // 読んだ行数 (取り込んだ行数とは別。進み具合の表示に使う)
    let mut read_rows = 0usize;
    let mut cancelled = false;
    // 1行版のINSERT (失敗したバッチから問題の行を探すときに使う)
    let one_row_sql = build_insert(db_type, &table_sql, &cols, 1, mode, &pk);
    let col_names: Vec<String> = cols.iter().map(|c| c.name.clone()).collect();
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
        // 行の出所 (ファイル上の行番号と列数)。params と同じ並びで持つ
        let mut metas: Vec<RowMeta> = Vec::with_capacity(batch);
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
                    params.extend(row.values);
                    metas.push(row.meta);
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
            rows_in_batch = crate::csv_import::dedupe_rows(
                &mut params,
                &mut metas,
                cols.len(),
                &pk_positions,
            );
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
        /*
         * バッチを SAVEPOINT で包む。
         *
         * PostgreSQLはエラーが出た時点でトランザクションが中止状態になり、
         * ROLLBACK以外を受け付けなくなるので、戻れる場所が要る。
         * MySQL / SQLite でも張っておく: デッドロックやディスク不足のように
         * トランザクションごと暗黙に巻き戻る失敗があり、そのまま1行ずつ流すと
         * **autocommit で確定してしまう**。戻れることを確かめてから探す
         *
         * 張れなかったときは包まずに進み、代わりに探索もしない
         */
        let guarded = savepoint(&mut session.conn, "SAVEPOINT", BATCH_SAVEPOINT)
            .await
            .is_ok();
        if let Err(e) = exec_bound_raw(&mut session.conn, &sql, &params).await {
            /*
             * 「中止」を押すとサーバー側からも1本を止めに行くので、
             * その結果のエラーが先に返ってくる。失敗として報告しない
             */
            if job.is_some_and(|j| j.is_cancelled()) {
                cancelled = true;
                break;
            }
            /*
             * どの行が悪いのかは、まとめて送ったINSERTのエラーからは分からない。
             * 巻き戻す前に、このバッチだけ1行ずつ送り直して突き止める
             * (成功した行もあとで全体ごと巻き戻る)。
             *
             * 探すのは「その行の中身が原因」と分かっている失敗だけ。
             * 接続断・デッドロック・容量不足では、
             * 送り直しても別の失敗になるか、バッチ先頭の無関係な行が犯人にされる
             */
            let failure = db::classify_failure(&e);
            let raw = db::format_db_error(e);
            let found = match row_hint(&failure) {
                // MySQLは「まとめて送った中の何行目か」を教えてくれる
                Some(at) if at <= metas.len() => Some(FailingRow {
                    meta: metas[at - 1],
                    values: params[(at - 1) * cols.len()..at * cols.len()].to_vec(),
                    error: raw.clone(),
                    failure: failure.clone(),
                }),
                _ if guarded && is_row_fault(&failure) => {
                    locate_failing_row(
                        session,
                        &one_row_sql,
                        &params,
                        &metas,
                        cols.len(),
                        job,
                    )
                    .await
                }
                _ => None,
            };
            /*
             * 探している途中で中止を押された場合 (探索は None で戻る)。
             * 失敗として報告せず、いつもの中止の流れに合わせる
             */
            if job.is_some_and(|j| j.is_cancelled()) {
                cancelled = true;
                break;
            }
            mark_rolling_back(job);
            let note = rollback_note(session, qlog, &label, &db_label).await;

            let detail = match &found {
                Some(bad) => crate::csv_import::failure_message(
                    &crate::csv_import::FailedRow {
                        meta: bad.meta,
                        header_width: reader.header_width(),
                        columns: &col_names,
                        types: &col_types,
                        values: &bad.values,
                        raw: &bad.error,
                    },
                    &bad.failure,
                ),
                // 行を特定できなかった場合 (探さなかった・再現しなかった)
                None => {
                    let head =
                        format!("{read_rows}行目までの取り込みに失敗しました: {raw}");
                    /*
                     * PostgreSQLで「重複は上書き」を選び、主キーの一部しか
                     * 取り込んでいないと、1文の中で同じ行を2回更新して失敗する
                     * (21000)。1行ずつなら通るので特定できない。
                     * この形はファイルの中の重複が原因なので、そう伝える
                     */
                    if failure == db::DbFailure::Duplicate {
                        format!("{head}\n{}", crate::csv_import::DUP_NOTE)
                    } else {
                        head
                    }
                }
            };
            return Err(format!("{detail}\n{note}"));
        }
        if guarded {
            /*
             * 溜めたままにするとサーバー側に副トランザクションが積み上がる。
             * 成功したぶんはここで手放す (失敗しても取り込みは続けられる)
             */
            let _ = savepoint(&mut session.conn, "RELEASE SAVEPOINT", BATCH_SAVEPOINT).await;
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
    exec_bound_raw(conn, sql, params).await.map_err(db::format_db_error)
}

/// `exec_bound_quiet` の、sqlxのエラーをそのまま返す版。
///
/// 失敗の種類 (重複キー・NOT NULL違反・型の不一致) は
/// エラー番号で見分けたいので、文言にする前のものが要る
async fn exec_bound_raw(
    conn: &mut DbConn,
    sql: &str,
    params: &[Option<String>],
) -> Result<u64, sqlx::Error> {
    // SQLは自前で組み立てた固定の形 (値はすべてプレースホルダ) なので安全
    let safe = sqlx::AssertSqlSafe(sql.to_string());
    match conn {
        DbConn::MySql(c) => {
            let mut q = sqlx::query(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            q.execute(&mut *c).await.map(|r| r.rows_affected())
        }
        DbConn::Pg(c) => {
            let mut q = sqlx::query(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            q.execute(&mut *c).await.map(|r| r.rows_affected())
        }
        DbConn::Sqlite(c) => {
            let mut q = sqlx::query(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            q.execute(&mut *c).await.map(|r| r.rows_affected())
        }
        DbConn::Kv(_) => Err(sqlx::Error::Protocol(
            "Valkey接続ではSQLは実行できません".to_string(),
        )),
    }
}

/*
 * SAVEPOINT の名前。
 *
 * 固定の文字列なのでSQLへ直接書いてよい (値は入らない)。
 * 利用者のSQLと衝突しないよう、アプリの名前を前に付けてある
 */
const BATCH_SAVEPOINT: &str = "quelio_csv_batch";
const PROBE_SAVEPOINT: &str = "quelio_csv_probe";

/// SAVEPOINT 系の1文を流す (`verb` は SAVEPOINT / RELEASE SAVEPOINT / ROLLBACK TO SAVEPOINT)。
///
/// BEGIN / COMMIT と同じく `raw_sql` で流す。
/// 制御文はプリペアドの控えに載せる意味が無い
async fn savepoint(conn: &mut DbConn, verb: &str, name: &str) -> Result<(), String> {
    let sql = sqlx::AssertSqlSafe(format!("{verb} {name}"));
    with_sql_conn!(conn, "Valkey接続ではSQLは実行できません", |c| {
        sqlx::raw_sql(sql)
            .execute(&mut *c)
            .await
            .map(|_| ())
            .map_err(db::format_db_error)
    })
}

/// 突き止めた「最初に失敗した行」
pub(super) struct FailingRow {
    pub meta: crate::csv_import::RowMeta,
    /// その行の値 (取り込み列の順)
    pub values: Vec<Option<String>>,
    /// DBが返した文言
    pub error: String,
    /// 失敗の種類 (言い換えに使う)
    pub failure: crate::db::DbFailure,
}

/**
 * 失敗したバッチの中から、最初に失敗した行を突き止める。
 *
 * まとめて送ったINSERTのエラーには「何行目か」が入っていない。
 * 巻き戻す前に、このバッチの行だけを1行ずつ送り直して確かめる。
 * 成功した行は、このあと全体を巻き戻すのでそのままでよい。
 *
 * 探すのは失敗したバッチだけ (2万行を1行ずつ送り直すと遅くなる)。
 * PostgreSQLは1文でも失敗するとトランザクションが中止状態になるため、
 * 1行ごとに SAVEPOINT で包んで戻しながら進める
 */
pub(super) async fn locate_failing_row(
    session: &mut Session,
    one_row_sql: &str,
    params: &[Option<String>],
    metas: &[crate::csv_import::RowMeta],
    width: usize,
    job: Option<&crate::csv_job::CsvJob>,
) -> Option<FailingRow> {
    if width == 0 {
        return None;
    }
    let rows = params.len() / width;
    // 行番号がそろっていないなら、間違った行を指すより何も言わない方がよい
    if rows == 0 || metas.len() != rows {
        return None;
    }
    /*
     * まず戻れる場所まで戻す。
     *
     * PostgreSQLは中止状態のままでは何も流せない。
     * ほかのDBでも、ここが失敗するならトランザクションが失われている
     * (デッドロックなどで暗黙に巻き戻った後) ので、探しにいかない。
     * そのまま1行ずつ流すと autocommit で確定してしまう
     */
    if savepoint(&mut session.conn, "ROLLBACK TO SAVEPOINT", BATCH_SAVEPOINT)
        .await
        .is_err()
    {
        return None;
    }

    for row in 0..rows {
        // 中止を押されたら探索もやめる (待たせ続けない)
        if job.is_some_and(|j| j.is_cancelled()) {
            return None;
        }
        let values = &params[row * width..(row + 1) * width];
        if savepoint(&mut session.conn, "SAVEPOINT", PROBE_SAVEPOINT)
            .await
            .is_err()
        {
            return None;
        }
        match exec_bound_raw(&mut session.conn, one_row_sql, values).await {
            Ok(_) => {
                let _ = savepoint(&mut session.conn, "RELEASE SAVEPOINT", PROBE_SAVEPOINT).await;
            }
            Err(e) => {
                // 中止の結果のエラーを「その行が悪い」と言わない
                if job.is_some_and(|j| j.is_cancelled()) {
                    let _ =
                        savepoint(&mut session.conn, "ROLLBACK TO SAVEPOINT", PROBE_SAVEPOINT)
                            .await;
                    return None;
                }
                let failure = crate::db::classify_failure(&e);
                let _ =
                    savepoint(&mut session.conn, "ROLLBACK TO SAVEPOINT", PROBE_SAVEPOINT).await;
                return Some(FailingRow {
                    meta: metas[row],
                    values: values.to_vec(),
                    error: db::format_db_error(e),
                    failure,
                });
            }
        }
    }
    None
}

/// その行の中身が原因だと分かっている失敗か。
///
/// 接続断・デッドロック・容量不足では、1行ずつ送り直しても
/// 別の失敗になるか、先頭の無関係な行が犯人にされる
fn is_row_fault(failure: &crate::db::DbFailure) -> bool {
    !matches!(failure, crate::db::DbFailure::Other)
}

/// まとめて送った中の何行目かが、エラー文から分かるなら返す (1始まり)
fn row_hint(failure: &crate::db::DbFailure) -> Option<usize> {
    match failure {
        crate::db::DbFailure::BadValue { row, .. } => *row,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{is_row_fault, row_hint};
    use crate::db::DbFailure;

    #[test]
    fn 中身が原因の失敗だけ探しにいく() {
        // 1行ずつ送り直せば同じ失敗が再現するもの
        assert!(is_row_fault(&DbFailure::BadValue {
            column: None,
            row: None
        }));
        assert!(is_row_fault(&DbFailure::Duplicate));
        assert!(is_row_fault(&DbFailure::NotNull { column: None }));
        /*
         * 接続断・デッドロック・容量不足。
         * 送り直しても別の失敗になるか、先頭の無関係な行が犯人にされる
         */
        assert!(!is_row_fault(&DbFailure::Other));
    }

    #[test]
    fn 行位置が分かるのは値の失敗のときだけ() {
        assert_eq!(
            row_hint(&DbFailure::BadValue {
                column: None,
                row: Some(3)
            }),
            Some(3)
        );
        assert_eq!(
            row_hint(&DbFailure::BadValue {
                column: None,
                row: None
            }),
            None
        );
        assert_eq!(row_hint(&DbFailure::Duplicate), None);
        assert_eq!(row_hint(&DbFailure::Other), None);
    }

    use crate::csv_job::CsvJobs;
    use crate::csv_import::{CsvOptions, ImportMode};
    use crate::models::ConnectionProfile;
    use crate::query_log::QueryLog;
    use crate::sessions::{CancelRegistry, Sessions};

    /// テスト用のSQLiteプロファイル (他のテストと同じ作り方)
    fn sqlite_profile(name: &str, path: &std::path::Path) -> ConnectionProfile {
        serde_json::from_str(&format!(
            r#"{{"name":"{name}","dbType":"sqlite","host":"","port":0,"user":"","database":{}}}"#,
            serde_json::to_string(&path.to_string_lossy()).expect("書けること")
        ))
        .expect("読めること")
    }

    fn cleanup(path: &std::path::Path) {
        for suffix in ["", "-wal", "-shm"] {
            let mut p = path.as_os_str().to_os_string();
            p.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(p));
        }
    }

    /**
     * 3行のうち2行目だけが失敗するCSVを取り込ませる。
     *
     * 確かめたいのは2つ:
     * - まとめて送ったINSERTが失敗しても、**何行目が悪いのか** を言えること
     * - そのあとの巻き戻しで、成功していた1行目も残っていないこと
     */
    #[tokio::test]
    async fn 失敗した行の番号と列名を言い当てて全部巻き戻す() {
        let dir = std::env::temp_dir();
        let db = dir.join(format!("quelio_csvfail_{}.db", std::process::id()));
        let csv = dir.join(format!("quelio_csvfail_{}.csv", std::process::id()));
        cleanup(&db);
        std::fs::File::create(&db).expect("作れること");
        // 1行目: 見出し / 2行目: 正しい / 3行目: memoが空 / 4行目: 正しい
        std::fs::write(&csv, "id,memo\n1,あ\n2,\n3,う\n").expect("書けること");

        let sessions = Sessions::default();
        let cancel = CancelRegistry::default();
        let qlog = QueryLog::default();
        let jobs = CsvJobs::default();
        crate::sessions::connect(
            &sessions,
            &cancel,
            &qlog,
            &jobs,
            "csvfail".into(),
            sqlite_profile("取り込み", &db),
        )
        .await
        .expect("繋がること");
        crate::sessions::exec_ddl(
            &sessions,
            &qlog,
            "csvfail",
            None,
            &["CREATE TABLE t(id INTEGER, memo TEXT NOT NULL)".into()],
        )
        .await
        .expect("表が作れること");

        let err = super::import_csv(
            &sessions,
            &qlog,
            "csvfail",
            None,
            None,
            "t",
            &csv,
            &CsvOptions {
                has_header: true,
                ..Default::default()
            },
            &[(0, "id".to_string()), (1, "memo".to_string())],
            ImportMode::Append,
            // 空欄をNULLにするので、memoが空の行でNOT NULL違反になる
            true,
            None,
        )
        .await
        .expect_err("失敗すること");

        // 「N行目まで」ではなく、悪い行そのものを指す (見出しを1行目として数える)
        assert!(err.contains("3行目"), "{err}");
        assert!(err.contains("`memo` は必須ですが空です"), "{err}");
        // 元のDBのエラー文も残す (推定が外れたときの手掛かり)
        assert!(err.contains("NOT NULL constraint failed"), "{err}");
        // 重複キーではないので、主キーの注記は出さない
        assert!(!err.contains("同じ主キーの行がファイルの中にある"), "{err}");

        // 探索で1行目は通っているが、全体の巻き戻しで残っていないこと
        let out = crate::sessions::run_query(
            &sessions,
            &qlog,
            "csvfail",
            None,
            "SELECT COUNT(*) FROM t",
            0,
            None,
            None,
            false,
            None,
            30,
            &Default::default(),
        )
        .await
        .expect("読めること");
        let rows = out
            .statements
            .into_iter()
            .next()
            .expect("結果があること")
            .result
            .rows;
        assert_eq!(rows[0][0].as_deref(), Some("0"), "{rows:?}");

        cleanup(&db);
        let _ = std::fs::remove_file(&csv);
    }

    /**
     * 行の中身が原因でない失敗では、1行ずつ送り直さない。
     *
     * デッドロックや容量不足はトランザクションごと巻き戻ることがあり、
     * その後に1行ずつ流すと autocommit で確定してしまう。
     * ここでは CHECK 違反 (種類を見分けられない失敗) で代表させ、
     * 行を名指しせず今までどおりの文言で返ることを見る
     */
    #[tokio::test]
    async fn 種類の分からない失敗では行を探さない() {
        let dir = std::env::temp_dir();
        let db = dir.join(format!("quelio_csvother_{}.db", std::process::id()));
        let csv = dir.join(format!("quelio_csvother_{}.csv", std::process::id()));
        cleanup(&db);
        std::fs::File::create(&db).expect("作れること");
        std::fs::write(&csv, "id,memo\n1,あ\n999,い\n").expect("書けること");

        let sessions = Sessions::default();
        let cancel = CancelRegistry::default();
        let qlog = QueryLog::default();
        let jobs = CsvJobs::default();
        crate::sessions::connect(
            &sessions,
            &cancel,
            &qlog,
            &jobs,
            "csvother".into(),
            sqlite_profile("取り込み", &db),
        )
        .await
        .expect("繋がること");
        crate::sessions::exec_ddl(
            &sessions,
            &qlog,
            "csvother",
            None,
            &["CREATE TABLE t(id INTEGER, memo TEXT, CHECK(id < 100))".into()],
        )
        .await
        .expect("表が作れること");

        let err = super::import_csv(
            &sessions,
            &qlog,
            "csvother",
            None,
            None,
            "t",
            &csv,
            &CsvOptions {
                has_header: true,
                ..Default::default()
            },
            &[(0, "id".to_string()), (1, "memo".to_string())],
            ImportMode::Append,
            false,
            None,
        )
        .await
        .expect_err("失敗すること");

        // 今までどおりの文言 (行を名指ししない)
        assert!(err.contains("行目までの取り込みに失敗しました"), "{err}");
        assert!(!err.contains("行目: "), "{err}");
        assert!(!err.contains("行目で失敗しました"), "{err}");
        assert!(err.contains("CHECK constraint failed"), "{err}");

        cleanup(&db);
        let _ = std::fs::remove_file(&csv);
    }
}
