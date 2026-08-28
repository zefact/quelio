//! 接続の確立と、その後の生存確認。
//!
//! つなぐまでに決めることが多い (SSHトンネル・TLS・読み取り専用・方言) うえ、
//! 切れていたら黙って張り直す必要もある。
//! 実行中の問い合わせと混ざると追いにくいので、ここへ分けている

use super::*;

/// 読み取り専用の接続では、サーバー側でも書き込みを禁止しておく (二重の防波堤)。
/// SQLiteは接続時に読み取り専用で開いており、Valkeyはコマンド単位で拒否する
pub(super) async fn apply_read_only(
    conn: &mut DbConn,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
) -> Result<(), String> {
    let sql = match conn {
        DbConn::MySql(_) => "SET SESSION TRANSACTION READ ONLY",
        DbConn::Pg(_) => "SET default_transaction_read_only = on",
        /*
         * SQLiteはファイル自体を読み取り専用で開いているが、
         * ATTACH した別のファイルまでは守れない。
         * query_only はこの接続からの書き込みを一律で断る
         */
        DbConn::Sqlite(_) => "PRAGMA query_only = ON",
        _ => return Ok(()),
    };
    exec_ctl(conn, qlog, label, db_label, sql).await?;
    Ok(())
}

/// サーバー側の読み取り専用が本当に効いているかを聞き直す。
///
/// 指定が通ってもサーバーが無視することがある
/// (MySQLの非トランザクションなストレージエンジンなど)。
/// 効いていないと、アプリ側の判定の抜けがそのまま穴になるので、
/// 分かる範囲で確かめて記録に残す
/// MySQL 8.0.3以降の名前
const MYSQL_RO_NEW: &str = "SELECT @@SESSION.transaction_read_only";
/// MySQL 8.0.3より前とMariaDBの名前
const MYSQL_RO_OLD: &str = "SELECT @@SESSION.tx_read_only";
const PG_RO: &str = "SHOW default_transaction_read_only";
const SQLITE_RO: &str = "PRAGMA query_only";

/// 読み取り専用を確かめられなかった理由を記録に残す
fn verify_failed(qlog: &QueryLog, label: &str, db_label: &str, e: &str) {
    qlog.add(
        label,
        db_label,
        &format!("-- 読み取り専用を確かめられませんでした ({e})"),
    );
}

async fn verify_read_only(
    conn: &mut DbConn,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
) -> Option<bool> {
    match conn {
        DbConn::MySql(c) => {
            qlog.add(label, db_label, MYSQL_RO_NEW);
            if let Ok(v) = sqlx::query_scalar::<_, i64>(MYSQL_RO_NEW)
                .fetch_one(&mut *c)
                .await
            {
                return Some(v == 1);
            }
            // 古いサーバーでは名前が違うだけなので、もう一方も試す
            qlog.add(label, db_label, MYSQL_RO_OLD);
            match sqlx::query_scalar::<_, i64>(MYSQL_RO_OLD)
                .fetch_one(&mut *c)
                .await
            {
                Ok(v) => Some(v == 1),
                Err(e) => {
                    verify_failed(qlog, label, db_label, &db::format_db_error(e));
                    None
                }
            }
        }
        DbConn::Pg(c) => {
            qlog.add(label, db_label, PG_RO);
            match sqlx::query_scalar::<_, String>(PG_RO).fetch_one(&mut *c).await {
                Ok(v) => Some(v.eq_ignore_ascii_case("on")),
                Err(e) => {
                    verify_failed(qlog, label, db_label, &db::format_db_error(e));
                    None
                }
            }
        }
        DbConn::Sqlite(c) => {
            qlog.add(label, db_label, SQLITE_RO);
            match sqlx::query_scalar::<_, i64>(SQLITE_RO)
                .fetch_one(&mut *c)
                .await
            {
                Ok(v) => Some(v == 1),
                Err(e) => {
                    verify_failed(qlog, label, db_label, &db::format_db_error(e));
                    None
                }
            }
        }
        DbConn::Kv(_) => None,
    }
}

/// 読み取り専用の確認結果を、接続ログに出す言葉にする
fn read_only_note(verified: Option<bool>) -> &'static str {
    match verified {
        Some(true) => " 読み取り専用=サーバー側でも有効",
        Some(false) => " 読み取り専用=※サーバー側では効いていません (アプリ側のみ)",
        None => " 読み取り専用=※サーバー側では確認できませんでした",
    }
}

/// 方言を聞き直し、その問い合わせもコンソールに残す。
///
/// 何を読んだ結果その方言になったのかが分からないと、
/// 「危険なSQLの確認が出ない」といった相談を追いかけられない
pub(super) async fn resolve_dialect(
    db: DbType,
    conn: &mut DbConn,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
) -> query::Dialect {
    let r = crate::dialect::resolve(db, conn).await;
    if let Some(sql) = r.sql {
        qlog.add(label, db_label, sql);
    }
    if let Some(e) = &r.error {
        qlog.add(
            label,
            db_label,
            &format!("-- 方言を確かめられませんでした ({e})。安全側に倒して読みます"),
        );
    }
    r.dialect
}

/// 接続を張り直したときに、失われるものを添える説明
const RECONNECT_LOSS: &str = concat!(
    "接続を張り直します ",
    "(未コミットの変更はサーバー側で取り消され、一時テーブル・セッション変数も失われます)"
);

/// 読み取り専用の接続では変更をさせない。
/// 利用者が開いたトランザクションが残っている間も変更させない
/// (Quelioが自前の BEGIN 〜 COMMIT を重ねると、その分まで確定してしまう)
pub(super) fn ensure_writable(session: &Session) -> Result<(), String> {
    if session.profile.read_only {
        return Err(READ_ONLY_MSG.to_string());
    }
    if session.txn == TxnState::User {
        return Err(USER_TXN_MSG.to_string());
    }
    Ok(())
}

/// プロファイルのログ表示名
pub(super) fn conn_label(profile: &ConnectionProfile) -> String {
    if !profile.name.is_empty() {
        return profile.name.clone();
    }
    // SQLiteはホスト:ポートを持たないため、ファイルパスを表示名にする
    if profile.db_type == DbType::Sqlite {
        return profile.database.clone().unwrap_or_default();
    }
    format!("{}:{}", profile.host, profile.port)
}

/// SQLiteのデータベースファイルパス
fn sqlite_path(profile: &ConnectionProfile) -> String {
    profile.database.clone().unwrap_or_default()
}

/// コンソールに出す接続先の説明
/// (例: MySQL app@db.example.com:3306 db=shop TLS SSH=ops@bastion:22)
fn conn_target_desc(profile: &ConnectionProfile) -> String {
    let kind = match profile.db_type {
        DbType::Mysql => "MySQL",
        DbType::Postgresql => "PostgreSQL",
        DbType::Sqlite => "SQLite",
        DbType::Valkey => "Valkey",
    };
    // SQLiteはローカルファイルなので、ホストではなくパスを出す
    if profile.db_type == DbType::Sqlite {
        return format!("{kind} file={}", sqlite_path(profile));
    }
    let mut s = kind.to_string();
    s.push(' ');
    if !profile.user.is_empty() {
        s.push_str(&profile.user);
        s.push('@');
    }
    s.push_str(&format!("{}:{}", profile.host, profile.port));
    if let Some(db) = profile.database.as_deref().filter(|d| !d.is_empty()) {
        // Valkeyの「データベース」は論理DB番号
        if profile.db_type == DbType::Valkey {
            s.push_str(&format!(" db番号={db}"));
        } else {
            s.push_str(&format!(" db={db}"));
        }
    }
    // TLSの扱いはDBごとに違う (ValkeyはON/OFF、MySQL/PostgreSQLはモード指定)
    match profile.db_type {
        DbType::Valkey => {
            if profile.tls {
                s.push_str(" TLS");
            }
        }
        _ => {
            let mode = db::SslMode::parse(profile.ssl_mode.as_deref());
            if mode != db::SslMode::Default {
                s.push(' ');
                s.push_str(mode.label());
            }
        }
    }
    if let Some(ssh) = profile.ssh.as_ref().filter(|c| c.enabled) {
        s.push_str(&format!(" SSH={}@{}:{}", ssh.user, ssh.host, ssh.port));
    }
    s
}

/// サーバー情報を1行にまとめる (コンソール表示用)
fn summarize_server_info(
    info: &[(String, String)],
    conn_id: i64,
    tls_state: Option<&str>,
) -> String {
    let mut parts: Vec<String> = info.iter().map(|(k, v)| format!("{k}={v}")).collect();
    if let Some(tls) = tls_state {
        parts.push(format!("実TLS={tls}"));
    }
    // 0はキャンセル不可 (接続IDを取得できなかった) を意味するので出さない
    if conn_id != 0 {
        parts.push(format!("接続ID={conn_id}"));
    }
    parts.join(" / ")
}

/// 実際にTLSで繋がったかをサーバーに聞く。
///
/// 設定 (TlsConfig) は「こう繋ぎたい」でしかなく、
/// 既定のままだと暗号化されたかどうかがログから分からない。
/// 取得できない場合はNoneを返し、接続は続ける (記録のためだけの問い合わせなので)
async fn fetch_tls_state(conn: &mut DbConn) -> Option<String> {
    match conn {
        DbConn::MySql(c) => {
            let row = sqlx::query_as::<_, (String, String)>(
                "SHOW SESSION STATUS LIKE 'Ssl_cipher'",
            )
            .fetch_optional(&mut *c)
            .await
            .ok()??;
            Some(if row.1.is_empty() {
                "なし (平文)".to_string()
            } else {
                row.1
            })
        }
        DbConn::Pg(c) => {
            let row = sqlx::query_as::<_, (bool, Option<String>, Option<String>)>(
                "SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
            )
            .fetch_optional(&mut *c)
            .await
            .ok()??;
            if !row.0 {
                return Some("なし (平文)".to_string());
            }
            let ver = row.1.unwrap_or_default();
            let cipher = row.2.unwrap_or_default();
            Some(format!("{ver} {cipher}").trim().to_string())
        }
        // SQLiteはローカルファイル、Valkeyは接続時の設定がそのまま結果になる
        DbConn::Sqlite(_) | DbConn::Kv(_) => None,
    }
}

/// 接続を確立してセッションに登録し、DB一覧を返す
pub async fn connect(
    sessions: &Sessions,
    cancel: &CancelRegistry,
    qlog: &QueryLog,
    jobs: &crate::csv_job::CsvJobs,
    session_id: String,
    profile: ConnectionProfile,
) -> Result<ConnectInfo, String> {
    if profile.password_locked {
        return Err(LOCKED_SECRET_MSG.to_string());
    }
    /*
     * 復号できなかった値は暗号文のまま渡ってくる。
     * password_locked は接続単位の1つしか無いので、
     * 片方だけ入れ直して解除されることがある。
     * 暗号文をそのままサーバーへ送らないよう、ここでも確かめる
     */
    let still_encrypted = profile.password.starts_with(crate::crypto::ENC_PREFIX)
        || profile
            .ssh
            .as_ref()
            .and_then(|s| s.passphrase.as_deref())
            .is_some_and(|p| p.starts_with(crate::crypto::ENC_PREFIX));
    if still_encrypted {
        return Err(LOCKED_SECRET_MSG.to_string());
    }
    let database = profile.database.as_deref().filter(|s| !s.is_empty());
    let label = conn_label(&profile);
    let started = std::time::Instant::now();
    // どこへ繋ぎに行ったかを先に残す (失敗した場合の切り分け用)
    qlog.add(
        &label,
        database.unwrap_or(""),
        &format!("-- 接続開始 {}", conn_target_desc(&profile)),
    );

    // SQLiteはローカルファイルなので、ホスト解決もSSHトンネルも行わない
    let ep = if profile.db_type == DbType::Sqlite {
        db::Endpoint {
            host: String::new(),
            port: 0,
            tunnel: None,
        }
    } else {
        db::resolve_endpoint(&profile).await?
    };
    if ep.tunnel.is_some() {
        qlog.add(
            &label,
            database.unwrap_or(""),
            &format!(
                "-- SSHトンネル確立 127.0.0.1:{} -> {}:{}",
                ep.port, profile.host, profile.port
            ),
        );
    }

    // TLS設定 (SSHトンネル経由ではホスト名を検証できないので、その旨も渡す)
    let tls = db::TlsConfig::from_profile(&profile, ep.tunnel.is_some());
    let (mut conn, databases, current_db, server_info) = match profile.db_type {
        DbType::Mysql => {
            let mut c = db::connect_mysql(
                &ep.host,
                ep.port,
                &profile.user,
                &profile.password,
                database,
                &tls,
            )
            .await?;
            let ctx = LogCtx {
                qlog,
                connection: &label,
                database: database.unwrap_or(""),
            };
            let dbs = catalog::mysql_databases(&mut c, &ctx).await?;
            let info = catalog::mysql_server_info(&mut c, &ctx).await?;
            (DbConn::MySql(c), dbs, database.map(str::to_string), info)
        }
        DbType::Postgresql => {
            // PostgreSQLは必ずどこかのDBに接続する必要があるため、
            // 未指定時は postgres → ユーザー名 → template1 の順で試す
            let (mut c, actual_db) = db::connect_pg_fallback(
                &ep.host,
                ep.port,
                &profile.user,
                &profile.password,
                database,
                &tls,
            )
            .await?;
            let ctx = LogCtx {
                qlog,
                connection: &label,
                database: &actual_db,
            };
            let dbs = catalog::pg_databases(&mut c, &ctx).await?;
            let info = catalog::pg_server_info(&mut c, &ctx).await?;
            (DbConn::Pg(c), dbs, Some(actual_db), info)
        }
        DbType::Sqlite => {
            // SQLiteはファイルを直接開く (ホスト・ポート・SSHは使わない)
            let path = sqlite_path(&profile);
            let mut c = db::connect_sqlite(&path, profile.read_only).await?;
            let ctx = LogCtx {
                qlog,
                connection: &label,
                database: SQLITE_DB,
            };
            let info = catalog::sqlite_server_info(&mut c, &path, &ctx).await?;
            (
                DbConn::Sqlite(c),
                vec![SQLITE_DB.to_string()],
                Some(SQLITE_DB.to_string()),
                info,
            )
        }
        DbType::Valkey => {
            // Valkeyの「データベース名」は論理DB番号 (既定は0-15)。
            // 読めない値を黙って0にすると、意図しないDBへ繋いでしまう
            let db_index: i64 = match database {
                Some(s) => s.parse().map_err(|_| format!("DB番号が不正です: {s}"))?,
                None => 0,
            };
            let mut c = kv::connect(
                &ep.host,
                ep.port,
                &profile.user,
                &profile.password,
                db_index,
                profile.tls,
                // SSHトンネル経由は接続先が127.0.0.1になるため、
                // SNI/証明書検証には本来のホスト名を使う
                ep.tunnel.is_some().then_some(profile.host.as_str()),
            )
            .await
            // 踏み台→接続先の失敗はローカルには接続リセットとしか見えないため、
            // トンネル側に控えた理由があればそちらを表示する
            .map_err(|e| {
                ep.tunnel
                    .as_ref()
                    .and_then(|t| t.take_error())
                    .unwrap_or(e)
            })?;
            let info = kv::server_info(&mut c).await?;
            // 論理DBの数はサーバーの設定で変わる (既定は16)
            let dbs: Vec<String> = (0..kv::db_count(&mut c).await)
                .map(|i| i.to_string())
                .collect();
            (DbConn::Kv(c), dbs, Some(db_index.to_string()), info)
        }
    };

    /*
     * ここから先で失敗したときは、確立した接続を閉じてから返す。
     * drop 任せにすると終了通知を送らないまま切ることになり、
     * サーバー側に接続が残る時間が延びる
     */
    let prepared = async {
        if profile.read_only {
            apply_read_only(&mut conn, qlog, &label, database.unwrap_or("")).await?;
        }
        // キャンセル用に接続IDを控えておく
        fetch_conn_id(&mut conn).await
    }
    .await;
    let conn_id = match prepared {
        Ok(id) => id,
        Err(e) => {
            close_conn_gracefully(conn).await;
            return Err(e);
        }
    };
    // 設定ではなく「実際に暗号化されたか」をサーバーに聞いて記録する。
    // SSH踏み台経由のときは通信路がSSHで守られているので、そうと分かるようにする
    let via_ssh = ep.tunnel.is_some();
    // 相手が本物かを確かめない設定か (既定・必須はどちらも検証しない)
    let unverified = matches!(
        db::SslMode::parse(profile.ssl_mode.as_deref()),
        db::SslMode::Default | db::SslMode::Require
    );
    let tls_state = fetch_tls_state(&mut conn).await.map(|s| {
        if via_ssh && s.starts_with("なし") {
            format!("{s} ※SSHトンネル内")
        } else if !via_ssh && unverified && !s.starts_with("なし") {
            // 暗号化はされたが、相手の証明書は確かめていない
            format!("{s} ※証明書は未検証")
        } else {
            s
        }
    });
    // 読み取り専用の指定が本当に効いたかを確かめ、記録に残す
    let ro_note = if profile.read_only {
        let db_label = current_db.clone().unwrap_or_default();
        read_only_note(verify_read_only(&mut conn, qlog, &label, &db_label).await)
    } else {
        ""
    };
    qlog.add(
        &label,
        current_db.as_deref().unwrap_or(""),
        &format!(
            "-- 接続完了 ({:.2}秒) {}{ro_note}",
            started.elapsed().as_secs_f64(),
            summarize_server_info(&server_info, conn_id, tls_state.as_deref())
        ),
    );
    // SQLiteは別接続から止められないので、この接続自身に中止の印を仕掛ける
    let sqlite_cancel = install_sqlite_cancel(&mut conn).await;
    cancel.register(
        session_id.clone(),
        CancelTarget {
            db_type: profile.db_type,
            label: label.clone(),
            host: ep.host.clone(),
            port: ep.port,
            user: profile.user.clone(),
            password: zeroize::Zeroizing::new(profile.password.clone()),
            conn_id,
            tls: profile.tls,
            tls_sni: ep.tunnel.is_some().then(|| profile.host.clone()),
            db_tls: db::TlsConfig::from_profile(&profile, ep.tunnel.is_some()),
            sqlite_cancel,
        },
    );

    // 文の区切り方はサーバー設定で変わるため、接続後に実際の値を聞いておく
    let dialect = resolve_dialect(
        profile.db_type,
        &mut conn,
        qlog,
        &label,
        current_db.as_deref().unwrap_or(""),
    )
    .await;

    let session = Session {
        id: session_id.clone(),
        cancel: cancel.clone(),
        host: ep.host.clone(),
        port: ep.port,
        tunnel: ep.tunnel,
        conn,
        dialect,
        txn: TxnState::None,
        current_db: current_db.clone(),
        databases: databases.clone(),
        profile,
        last_used: std::time::Instant::now(),
    };
    /*
     * 同じキーで既存セッションがあれば正しく閉じてから置き換える。
     * 前の接続で動いていたジョブは行き先を失うので中止する。
     * 新しいジョブを巻き添えにしないよう、差し替えと中止は
     * マップのロックを持ったまま続けて行う
     * (ジョブを始めるコマンドは、必ず先にこのマップを引くため)
     */
    let old = {
        let mut map = sessions.0.lock().await;
        let old = map.insert(session_id.clone(), Arc::new(Mutex::new(session)));
        if old.is_some() {
            jobs.cancel_session(&session_id);
        }
        old
    };
    if let Some(old) = old {
        close_session_arc(old, qlog).await;
    }

    Ok(ConnectInfo {
        databases,
        current_db,
        server_info,
    })
}

/// 接続IDを取得する (MySQL: CONNECTION_ID / PG: pg_backend_pid / Valkey: CLIENT ID)
pub(super) async fn fetch_conn_id(conn: &mut DbConn) -> Result<i64, String> {
    match conn {
        DbConn::MySql(c) => sqlx::query_scalar::<_, i64>("SELECT CAST(CONNECTION_ID() AS SIGNED)")
            .fetch_one(&mut *c)
            .await
            .map_err(db::format_db_error),
        DbConn::Pg(c) => sqlx::query_scalar::<_, i32>("SELECT pg_backend_pid()")
            .fetch_one(&mut *c)
            .await
            .map(|pid| pid as i64)
            .map_err(db::format_db_error),
        // SQLiteは他プロセスから中断できないため0 (キャンセル不可)
        DbConn::Sqlite(_) => Ok(0),
        // ElastiCache Serverless等はCLIENT IDをサポートしないため、
        // 失敗しても接続は継続し0 (キャンセル不可) として扱う
        DbConn::Kv(c) => Ok(redis::cmd("CLIENT")
            .arg("ID")
            .query_async::<i64>(c)
            .await
            .unwrap_or(0)),
    }
}

/// 接続にpingを送って生存確認する (タイムアウト・エラーはfalse)
async fn ping_conn(conn: &mut DbConn) -> bool {
    match conn {
        DbConn::MySql(c) => matches!(timeout(PING_TIMEOUT, c.ping()).await, Ok(Ok(()))),
        DbConn::Pg(c) => matches!(timeout(PING_TIMEOUT, c.ping()).await, Ok(Ok(()))),
        DbConn::Sqlite(c) => matches!(timeout(PING_TIMEOUT, c.ping()).await, Ok(Ok(()))),
        DbConn::Kv(c) => matches!(
            timeout(PING_TIMEOUT, redis::cmd("PING").query_async::<String>(c)).await,
            Ok(Ok(_))
        ),
    }
}

/// 接続を張り直す (SSHトンネル使用時はトンネルごと再構築)。
/// `dead` は「接続が切れていたため」かどうか (ログの説明を変えるだけ)
async fn reconnect(session: &mut Session, qlog: &QueryLog, dead: bool) -> Result<(), String> {
    let label = conn_label(&session.profile);
    let db_label = session.current_db.clone().unwrap_or_default();
    if dead {
        qlog.add(
            &label,
            &db_label,
            &format!(
                "-- 接続が切れていたため再接続します {}",
                conn_target_desc(&session.profile)
            ),
        );
    } else {
        qlog.add(
            &label,
            &db_label,
            &format!("-- 接続し直します {}", conn_target_desc(&session.profile)),
        );
    }

    // SSHトンネル使用時はトンネルも張り直す (ローカルポートが変わる)
    if session.tunnel.is_some() {
        if let Some(t) = session.tunnel.as_mut() {
            t.close().await;
        }
        let ep = db::resolve_endpoint(&session.profile).await?;
        session.host = ep.host;
        session.port = ep.port;
        session.tunnel = ep.tunnel;
        qlog.add(
            &label,
            &db_label,
            &format!(
                "-- SSHトンネル再確立 127.0.0.1:{} -> {}:{}",
                session.port, session.profile.host, session.profile.port
            ),
        );
    }

    let database = session.current_db.clone();
    let tls = db::TlsConfig::from_profile(&session.profile, session.tunnel.is_some());
    let new_conn = match session.profile.db_type {
        DbType::Mysql => DbConn::MySql(
            db::connect_mysql(
                &session.host,
                session.port,
                &session.profile.user,
                &session.profile.password,
                database.as_deref(),
                &tls,
            )
            .await?,
        ),
        DbType::Postgresql => {
            let (c, actual_db) = db::connect_pg_fallback(
                &session.host,
                session.port,
                &session.profile.user,
                &session.profile.password,
                database.as_deref(),
                &tls,
            )
            .await?;
            session.current_db = Some(actual_db);
            DbConn::Pg(c)
        }
        DbType::Sqlite => DbConn::Sqlite(
            db::connect_sqlite(&sqlite_path(&session.profile), session.profile.read_only).await?,
        ),
        DbType::Valkey => {
            let db_index: i64 = database
                .as_deref()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            DbConn::Kv(
                kv::connect(
                    &session.host,
                    session.port,
                    &session.profile.user,
                    &session.profile.password,
                    db_index,
                    session.profile.tls,
                    session.tunnel.is_some().then_some(session.profile.host.as_str()),
                )
                .await
                .map_err(|e| {
                    session
                        .tunnel
                        .as_ref()
                        .and_then(|t| t.take_error())
                        .unwrap_or(e)
                })?,
            )
        }
    };

    // 旧接続の分のトランザクションはサーバーが巻き戻す。
    // 差し替えと同時に状態を落とす (間に await を挟むと途中で打ち切られうる)
    let old = std::mem::replace(&mut session.conn, new_conn);
    session.txn = TxnState::None;
    invalidate_cancel_conn(session);
    close_conn_gracefully(old).await;
    // 接続が変わったので方言を解決し直す
    session.dialect = resolve_dialect(
        session.profile.db_type,
        &mut session.conn,
        qlog,
        &label,
        &db_label,
    )
    .await;

    /*
     * キャンセル用の接続IDを先に更新する。
     * 古いIDを残したままだと、キャンセル操作が
     * 同じ番号を割り当てられた無関係な接続を止めてしまう
     */
    // 接続が変わったので、中止の印も新しい接続のものに差し替える
    let sqlite_cancel = install_sqlite_cancel(&mut session.conn).await;
    if let Ok(conn_id) = fetch_conn_id(&mut session.conn).await {
        session.cancel.edit(&session.id, |t| {
            t.conn_id = conn_id;
            t.host = session.host.clone();
            t.port = session.port;
            t.sqlite_cancel = sqlite_cancel;
        });
    }

    if session.profile.read_only {
        // サーバー側の読み取り専用を掛けられなかった接続は使わせない。
        // Broken にしておけば、次の操作でまた張り直しに来る
        if let Err(e) = apply_read_only(&mut session.conn, qlog, &label, &db_label).await {
            session.txn = TxnState::Broken;
            return Err(e);
        }
    }

    session.last_used = std::time::Instant::now();
    qlog.add(
        &label,
        session.current_db.as_deref().unwrap_or(""),
        "-- 再接続しました",
    );
    Ok(())
}

/// 操作の前に接続の生存を保証する。
/// しばらく使われていなかった場合はpingし、切れていれば自動で再接続する
pub(super) async fn ensure_alive(session: &mut Session, qlog: &QueryLog) -> Result<(), String> {
    // 前の操作で立った中止の印は、ここで必ず落とす
    // (残っていると、この後の後始末や実行がすべて打ち切られる)
    clear_sqlite_cancel(session);
    /*
     * トランザクションが開いたままの接続を次の操作へ持ち越さない。
     *
     * MySQLは BEGIN で開いていたトランザクションを暗黙コミットするため、
     * ROLLBACK に失敗したまま次を実行すると「取り消したはず」の変更が
     * 確定してしまう。接続を張り直せばサーバー側が必ず巻き戻す。
     * (張り直しに失敗したら状態はそのまま残るので、次の操作でまた試す)
     */
    if let Some(note) = txn_cleanup_note(session.txn) {
        let label = conn_label(&session.profile);
        let db_label = session.current_db.clone().unwrap_or_default();
        /*
         * まず ROLLBACK をやり直す。
         * 通れば接続はそのまま使えるので、一時テーブルやセッション変数を失わずに済む
         */
        if end_txn(session, qlog, &label, &db_label, false).await.is_ok() {
            /*
             * 接続を張り直した直後にサーバー側の読み取り専用を掛け損ねている
             * 可能性があるので、掛け直してから使う (同じ指定を繰り返しても害はない)
             */
            if session.profile.read_only {
                apply_read_only(&mut session.conn, qlog, &label, &db_label).await?;
            }
            qlog.add(&label, &db_label, &format!("-- {note}。取り消しました"));
            session.last_used = std::time::Instant::now();
            return Ok(());
        }
        // 取り消せない = この接続はもう信用できないので張り直す
        // (張り直しにも失敗したら状態はそのまま残るので、次の操作でまた試す)
        qlog.add(&label, &db_label, &format!("-- {note}。{RECONNECT_LOSS}"));
        return reconnect(session, qlog, false).await;
    }
    if session.last_used.elapsed() < IDLE_PING_AFTER {
        session.last_used = std::time::Instant::now();
        return Ok(());
    }
    if ping_conn(&mut session.conn).await {
        session.last_used = std::time::Instant::now();
        return Ok(());
    }
    reconnect(session, qlog, true).await
}

/// 全セッションに定期pingを送り、アイドル切断を防ぐ (バックグラウンドで定期実行)。
/// pingに失敗しても何もしない (次の操作時にensure_aliveが再接続する)。
///
/// 残ったトランザクションはここでも片付ける。
/// pingはサーバー側のアイドルタイムアウト
/// (MySQLの wait_timeout / PostgreSQLの idle_in_transaction_session_timeout) を
/// そのたびに延ばしてしまうため、放っておくとロックが解放されない
pub async fn keepalive_all(sessions: &Sessions, qlog: &QueryLog) {
    // マップのロックはArcの複製だけで即解放し、pingはセッション個別に行う
    let list: Vec<Arc<Mutex<Session>>> =
        sessions.0.lock().await.values().cloned().collect();
    for arc in list {
        // 使用中 (クエリ実行中など) のセッションはスキップ (使われている = 生きている)
        let Ok(mut session) = arc.try_lock() else {
            continue;
        };
        if txn_cleanup_note(session.txn).is_some() {
            // 次の操作を待たずに取り消す (待つとロックを掴んだままになる)。
            // 再接続まで行くと時間が読めないので上限を付ける
            // (このループは直列なので、1つで詰まると他のセッションが後回しになる)
            let _ = timeout(CLEANUP_TIMEOUT, ensure_alive(&mut session, qlog)).await;
            continue;
        }
        /*
         * 利用者が自分で開いたトランザクションにはpingを送らない。
         * pingはサーバー側のアイドルタイムアウトを延ばしてしまうため、
         * 送り続けると掴んだロックがいつまでも解放されない
         */
        if session.txn == TxnState::User {
            continue;
        }
        if ping_conn(&mut session.conn).await {
            session.last_used = std::time::Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 読み取り専用の確認結果を言葉にする() {
        // 効いていないときは、そうと分かる書き方にする
        assert!(read_only_note(Some(true)).contains("有効"));
        assert!(read_only_note(Some(false)).contains("効いていません"));
        assert!(read_only_note(None).contains("確認できませんでした"));
        // 3つとも別の文言 (取り違えると穴に気づけない)
        assert_ne!(read_only_note(Some(true)), read_only_note(Some(false)));
        assert_ne!(read_only_note(Some(false)), read_only_note(None));
    }
}
