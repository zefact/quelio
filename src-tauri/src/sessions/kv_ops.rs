//! Valkey (KV) セッションの操作。
//!
//! SQLのDBと同じセッションの仕組みに乗せているが、
//! 問い合わせの形はまったく違う (キーの走査・型ごとの取得・一括削除)。
//! 混ざると読みにくいので、こちらへ分けている

use super::*;

/// Valkeyで指定の論理DBを選択していなければSELECTで切り替える
async fn ensure_kv_db(
    session: &mut Session,
    database: &str,
    qlog: &QueryLog,
) -> Result<(), String> {
    if session.current_db.as_deref() == Some(database) {
        return Ok(());
    }
    let idx: i64 = database
        .parse()
        .map_err(|_| format!("DB番号が不正です: {database}"))?;
    let label = conn_label(&session.profile);
    qlog.add(&label, database, &format!("SELECT {idx}"));
    match &mut session.conn {
        DbConn::Kv(c) => {
            redis::cmd("SELECT")
                .arg(idx)
                .query_async::<()>(c)
                .await
                .map_err(kv::format_err)?;
        }
        _ => return Err("Valkey接続ではありません".into()),
    }
    session.current_db = Some(database.to_string());
    Ok(())
}

/// Valkey: キー一覧をSCANで1ページぶん取得する
pub async fn kv_scan(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    pattern: &str,
    cursor: &str,
) -> Result<kv::KvScanResult, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    ensure_kv_db(session, database, qlog).await?;
    let label = conn_label(&session.profile);
    qlog.add(
        &label,
        database,
        &format!("SCAN {cursor} MATCH {pattern} COUNT {}", kv::SCAN_COUNT),
    );
    match &mut session.conn {
        DbConn::Kv(c) => kv::scan(c, pattern, cursor).await,
        _ => Err("Valkey接続ではありません".into()),
    }
}

/// Valkey: キーの詳細 (型・TTL・値プレビュー) を返す
pub async fn kv_key_detail(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    key: &str,
) -> Result<kv::KvKeyDetail, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    ensure_kv_db(session, database, qlog).await?;
    match &mut session.conn {
        DbConn::Kv(c) => kv::key_detail(c, key).await,
        _ => Err("Valkey接続ではありません".into()),
    }
}

/// Valkey: コマンド (複数行) を逐次実行する
pub async fn kv_exec(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    commands: Vec<String>,
    confirmed: bool,
) -> Result<kv::KvRunOutput, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    ensure_kv_db(session, database, qlog).await?;
    let label = conn_label(&session.profile);
    // 履歴に残す前にパスワードを伏せる (AUTH / CONFIG SET requirepass など)
    for c in &commands {
        qlog.add(&label, database, &kv::mask_secrets(c));
    }
    let read_only = session.profile.read_only;
    match &mut session.conn {
        DbConn::Kv(c) => kv::exec(c, &commands, read_only, confirmed).await,
        _ => Err("Valkey接続ではありません".into()),
    }
}

/// Valkey: キーの値を変更する (追加・削除・TTL変更も含む)
pub async fn kv_apply(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    change: kv::KvChange,
) -> Result<(), String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_writable(session)?;
    ensure_alive(session, qlog).await?;
    ensure_kv_db(session, database, qlog).await?;
    let label = conn_label(&session.profile);
    let done = match &mut session.conn {
        DbConn::Kv(c) => kv::apply_change(c, &change).await,
        _ => Err("Valkey接続ではありません".into()),
    }?;
    qlog.add(&label, database, &done);
    Ok(())
}

/// テーブル名・カラム名・コメントから探す
/// テーブル名・カラム名・コメントから探す。
///
/// 探す範囲は**画面で選んでいるデータベースの中だけ**にする。
/// 画面に出ている範囲と探す範囲を一致させるためで、
/// サーバー内の全データベースを見に行くと、
/// 別のデータベースの結果が混ざって「今どこを見ているのか」が分からなくなる
pub async fn search_objects(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: Option<String>,
    keyword: &str,
) -> Result<crate::search::ObjectSearchResult, String> {
    if keyword.trim().is_empty() {
        return Err("探す文字列を入力してください".into());
    }
    // 探す範囲が決まらないので、選んでいなければここで断る
    let db_label = crate::search::search_scope(database.as_deref())?.to_string();
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    if matches!(session.conn, DbConn::Kv(_)) {
        return Err("Valkey接続ではこの操作はできません".into());
    }
    let label = conn_label(&session.profile);
    // PostgreSQLは接続したデータベースの中しか見えないので、指定があれば切り替える
    if session.profile.db_type == DbType::Postgresql {
        ensure_database(session, database.as_ref(), qlog, &label).await?;
    }
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database: &db_label,
    };
    // MySQLは information_schema から全データベースが見えてしまうので、条件で絞る
    let found = match &mut session.conn {
        DbConn::MySql(c) => crate::search::mysql_objects(c, &db_label, keyword, &ctx).await,
        DbConn::Pg(c) => crate::search::pg_objects(c, &db_label, keyword, &ctx).await,
        DbConn::Sqlite(c) => crate::search::sqlite_objects(c, keyword, &ctx).await,
        DbConn::Kv(_) => unreachable!(),
    };
    // 打ち切った接続は状態がずれうるので、次の操作で生存確認させる
    let hits = note_timeout(session, found)?;
    let truncated = hits.len() >= crate::search::OBJECT_TOTAL_LIMIT;
    Ok(crate::search::ObjectSearchResult { hits, truncated })
}

/// 値の中から文字列を探す (選んだデータベースの中を総当たりする)
pub async fn search_values(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: Option<String>,
    opts: crate::search::ValueSearchOptions,
    job: Option<&crate::csv_job::CsvJob>,
) -> Result<crate::search::ValueSearchResult, String> {
    if opts.needle.trim().is_empty() {
        return Err("探す文字列を入力してください".into());
    }
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    // ここから先は接続を握っている。サーバーへ中止を送っても、無関係なSQLを止めることはない
    if let Some(j) = job {
        j.mark_running();
    }
    if matches!(session.conn, DbConn::Kv(_)) {
        return Err("Valkey接続ではこの操作はできません".into());
    }
    // SQLite以外はどのデータベースを見るかが決まっていないと探せない
    if !matches!(session.conn, DbConn::Sqlite(_))
        && database.as_deref().unwrap_or("").is_empty()
    {
        return Err("データベースを選んでください".into());
    }
    let label = conn_label(&session.profile);
    let db_label = database.clone().unwrap_or_default();
    ensure_database(session, database.as_ref(), qlog, &label).await?;
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database: &db_label,
    };

    // まず対象の列を集めてから、テーブル単位で見に行く
    let found = match &mut session.conn {
        DbConn::MySql(c) => crate::search::mysql_value_columns(c, &db_label, &ctx).await,
        DbConn::Pg(c) => crate::search::pg_value_columns(c, &ctx).await,
        DbConn::Sqlite(c) => crate::search::sqlite_value_columns(c, &ctx).await,
        DbConn::Kv(_) => unreachable!(),
    };
    // 打ち切った接続は状態がずれうるので、次の操作で生存確認させる
    let columns = note_timeout(session, found)?;
    let tables = crate::search::group_by_table(columns);

    let out = match &mut session.conn {
        DbConn::MySql(c) => crate::search::mysql_values(c, tables, &opts, job, &ctx).await,
        DbConn::Pg(c) => crate::search::pg_values(c, tables, &opts, job, &ctx).await,
        DbConn::Sqlite(c) => {
            crate::search::sqlite_values(c, tables, &opts, job, &ctx).await
        }
        DbConn::Kv(_) => unreachable!(),
    };
    qlog.add(
        &label,
        &db_label,
        &format!(
            "-- 値の検索{} {}テーブルを確認・{}件",
            if out.cancelled { "を中止" } else { "完了" },
            out.scanned,
            out.hits.len()
        ),
    );
    Ok(out)
}

/// Valkey: パターンに一致するキーを数える (消す前の確認用)
pub async fn kv_count_keys(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    pattern: &str,
    job: Option<&crate::csv_job::CsvJob>,
) -> Result<crate::kv_bulk::KvCountResult, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    // ここから先は接続を握っている。サーバーへ中止を送っても、無関係なSQLを止めることはない
    if let Some(j) = job {
        j.mark_running();
    }
    ensure_kv_db(session, database, qlog).await?;
    // 数えるだけなら全件のパターンも許す (消すときだけ確認を取る)
    crate::kv_bulk::check_pattern(pattern, true)?;
    let label = conn_label(&session.profile);
    qlog.add(&label, database, &format!("-- キーを数える MATCH {pattern}"));
    match &mut session.conn {
        DbConn::Kv(c) => crate::kv_bulk::count_keys(c, pattern, job).await,
        _ => Err("Valkey接続ではありません".into()),
    }
}

/// Valkey: パターンに一致するキーをまとめて消す
pub async fn kv_delete_keys(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    pattern: &str,
    // confirmed_all: 全件が対象になると分かったうえで実行するか
    confirmed_all: bool,
    job: Option<&crate::csv_job::CsvJob>,
) -> Result<crate::kv_bulk::KvDeleteResult, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_writable(session)?;
    ensure_alive(session, qlog).await?;
    // ここから先は接続を握っている。サーバーへ中止を送っても、無関係なSQLを止めることはない
    if let Some(j) = job {
        j.mark_running();
    }
    ensure_kv_db(session, database, qlog).await?;
    crate::kv_bulk::check_pattern(pattern, confirmed_all)?;
    let label = conn_label(&session.profile);
    qlog.add(&label, database, &format!("UNLINK (MATCH {pattern})"));
    let out = match &mut session.conn {
        DbConn::Kv(c) => crate::kv_bulk::delete_keys(c, pattern, job).await,
        _ => Err("Valkey接続ではありません".into()),
    }?;
    qlog.add(
        &label,
        database,
        &format!(
            "-- キーの一括削除{} {}件",
            if out.cancelled { "を中止" } else { "完了" },
            out.deleted
        ),
    );
    Ok(out)
}

/// Valkey: 値の中から文字列を探す
pub async fn kv_search(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    pattern: &str,
    opts: crate::kv_bulk::KvSearchOptions,
    job: Option<&crate::csv_job::CsvJob>,
) -> Result<crate::kv_bulk::KvSearchResult, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    // ここから先は接続を握っている。サーバーへ中止を送っても、無関係なSQLを止めることはない
    if let Some(j) = job {
        j.mark_running();
    }
    ensure_kv_db(session, database, qlog).await?;
    let label = conn_label(&session.profile);
    qlog.add(
        &label,
        database,
        &format!("-- 値を検索 MATCH {pattern}"),
    );
    match &mut session.conn {
        DbConn::Kv(c) => crate::kv_bulk::search_values(c, pattern, &opts, job).await,
        _ => Err("Valkey接続ではありません".into()),
    }
}
