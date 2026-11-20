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
    let res = match &mut session.conn {
        DbConn::Kv(c) => kv::scan(c, pattern, cursor).await,
        _ => Err("Valkey接続ではありません".into()),
    };
    note_kv_result(session, &res);
    res
}

/// 接続が切れた種類の失敗なら、次の操作の入口で張り直させる
/// (入口の生存確認は、最後の操作から30秒たつまで走らないため)
fn note_kv_result<T>(session: &mut Session, res: &Result<T, String>) {
    if let Err(e) = res {
        note_disconnected(session, e);
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
    let res = match &mut session.conn {
        DbConn::Kv(c) => kv::key_detail(c, key).await,
        _ => Err("Valkey接続ではありません".into()),
    };
    note_kv_result(session, &res);
    res
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
    let label = conn_label(&session.profile);
    let res = async {
        ensure_alive(session, qlog).await?;
        ensure_kv_db(session, database, qlog).await?;
        // 履歴に残す前にパスワードを伏せる (AUTH / CONFIG SET requirepass など)
        for c in &commands {
            qlog.add(&label, database, &kv::mask_secrets(c));
        }
        let read_only = session.profile.read_only;
        // 本番では書き込み系すべてを確認の対象にする
        // (読み取り専用なら、そもそも書き込みは上で断られる)
        let prod = session.profile.env.as_deref() == Some("prod") && !read_only;
        match &mut session.conn {
            DbConn::Kv(c) => kv::exec(c, &commands, read_only, confirmed, prod).await,
            _ => Err("Valkey接続ではありません".into()),
        }
    }
    .await;
    /*
     * 「中止」で止めた場合は、接続が切れたエラーではなく「中止しました」として返す。
     * 止めた接続はもう使えないので、次の操作の入口で張り直させる
     */
    if kv_stop_requested(session) {
        mark_needs_ping(session);
        qlog.add(&label, database, "-- コマンドを中止しました (次の操作の前に接続を張り直します)");
        let done = res.map(|out| out.statements).unwrap_or_default();
        return Ok(kv::cancelled_output(done));
    }
    match &res {
        Ok(out) => {
            if let Some(e) = &out.error {
                note_disconnected(session, e);
            }
        }
        Err(e) => note_disconnected(session, e),
    }
    res
}

/// このセッションで「中止」が押されたか (押された接続はもう使えない)
pub(super) fn kv_stop_requested(session: &Session) -> bool {
    session
        .cancel
        .get(&session.id)
        .and_then(|t| t.kv_stop)
        .is_some_and(|s| s.requested())
}

/// Valkey: 実行中のコマンドを中止する。
///
/// サーバーに止めてもらうのではなく、こちらが応答を待つのをやめて接続を捨てる。
/// Valkey はコマンドを1つずつしか処理しないので、重いコマンド (KEYS など) の
/// 実行中は、別の接続から送った CLIENT KILL も終わるまで届かないため。
/// 接続を閉じれば、待ち続けるコマンド (BLPOP など) はサーバー側でも片付く。
///
/// セッションのロックは取らない (実行中はずっと掴まれているため)。
/// 次の操作は、入口 (ensure_alive) で新しい接続を張ってから動く
pub fn kv_cancel(
    cancel: &CancelRegistry,
    qlog: &QueryLog,
    session_id: &str,
) -> Result<(), String> {
    let target = cancel.get(session_id).ok_or("接続されていません")?;
    let Some(stop) = target.kv_stop else {
        return Err("接続し直している最中のため、いまは中止できません".into());
    };
    qlog.add(
        &target.label,
        "",
        "-- 実行中のコマンドを中止 (応答を待たずに接続を切ります)",
    );
    stop.stop();
    Ok(())
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
    };
    note_kv_result(session, &done);
    let done = done?;
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
    qlog.add(
        &label,
        database,
        &format!("-- キーを数える MATCH {pattern}"),
    );
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
    qlog.add(&label, database, &format!("-- 値を検索 MATCH {pattern}"));
    match &mut session.conn {
        DbConn::Kv(c) => crate::kv_bulk::search_values(c, pattern, &opts, job).await,
        _ => Err("Valkey接続ではありません".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(kv_stop: Option<KvStop>) -> CancelTarget {
        CancelTarget {
            db_type: DbType::Valkey,
            label: "テスト".into(),
            host: "127.0.0.1".into(),
            port: 6379,
            user: String::new(),
            password: zeroize::Zeroizing::new(String::new()),
            conn_id: 1,
            db_tls: db::TlsConfig::default(),
            sqlite_cancel: None,
            kv_stop,
        }
    }

    #[tokio::test]
    async fn 中止は送受信のタスクを止めて印を立てる() {
        let cancel = CancelRegistry::default();
        let qlog = QueryLog::default();
        // 終わらないタスクを、接続の送受信の代わりにする
        let task = tokio::spawn(std::future::pending::<()>());
        let stop = KvStop::new(task.abort_handle());
        cancel.register("s1".into(), target(Some(stop.clone())));

        assert!(!stop.requested());
        kv_cancel(&cancel, &qlog, "s1").unwrap();
        assert!(stop.requested());
        // 止めたタスクは中断で終わる
        let joined = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .expect("止めたタスクが終わらない");
        assert!(joined.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn 止め口が無いときは中止できないと返す() {
        let cancel = CancelRegistry::default();
        let qlog = QueryLog::default();
        // 張り直している最中 (止め口が外れている)
        cancel.register("s1".into(), target(None));
        assert!(kv_cancel(&cancel, &qlog, "s1").is_err());
        // 接続していない
        assert!(kv_cancel(&cancel, &qlog, "none").is_err());
    }
}
