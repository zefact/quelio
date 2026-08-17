//! アクティブなDB接続(セッション)の管理

use std::collections::HashMap;
use std::sync::Arc;

use sqlx::mysql::MySqlConnection;
use sqlx::postgres::PgConnection;
use sqlx::sqlite::SqliteConnection;
use sqlx::Connection;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

use crate::catalog::{self, LogCtx};
use crate::db;
use crate::export;
use crate::kv;
use crate::models::{
    ConnectInfo, ConnectionProfile, DbType, RunOutput, SchemaEntry, SessionSummary,
    StatementResult, TableDetail, TableInfo,
};
use crate::query;
use crate::query_log::QueryLog;
use crate::ssh_tunnel::SshTunnel;

pub enum DbConn {
    MySql(MySqlConnection),
    Pg(PgConnection),
    Sqlite(SqliteConnection),
    Kv(redis::aio::MultiplexedConnection),
}

/// SQLiteは単一ファイル = 単一DBのため、DB一覧はこの名前だけを返す
const SQLITE_DB: &str = "main";

const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);
/// 生存確認pingのタイムアウト
const PING_TIMEOUT: Duration = Duration::from_secs(5);
/// この時間以上操作がなかったら、次の操作の前にpingで生存確認する
const IDLE_PING_AFTER: Duration = Duration::from_secs(30);

/// 実行中クエリをキャンセルするための接続情報
#[derive(Clone)]
pub struct CancelTarget {
    pub db_type: DbType,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    /// MySQL: CONNECTION_ID() / PostgreSQL: pg_backend_pid()
    pub conn_id: i64,
    /// Valkey: TLSで接続するか (キャンセル用の別接続にも同じ設定を使う)
    pub tls: bool,
    /// Valkey: TLSのSNI/証明書検証に使う本来のホスト名 (SSHトンネル経由時)
    pub tls_sni: Option<String>,
}

/// セッションID → キャンセル対象 (クエリ実行中でも参照できるよう独立したロック)
#[derive(Default, Clone)]
pub struct CancelRegistry(pub std::sync::Arc<std::sync::Mutex<HashMap<String, CancelTarget>>>);

pub struct Session {
    /// セッションID (CancelRegistryのキー)
    id: String,
    /// キャンセル用レジストリ (PG再接続時にconn_idを更新する)
    cancel: CancelRegistry,
    profile: ConnectionProfile,
    /// SSHトンネル。セッションが生きている間は保持し続ける
    tunnel: Option<SshTunnel>,
    /// 解決済みの接続先(トンネル使用時は127.0.0.1:ローカルポート)
    host: String,
    port: u16,
    conn: DbConn,
    current_db: Option<String>,
    /// 接続時に取得したデータベース一覧 (差分ビューアの選択肢用)
    databases: Vec<String>,
    /// 最後に接続を使った時刻 (キープアライブ・生存確認用)
    last_used: std::time::Instant,
}

/// セッションID(タブ単位) → Session のマップ (Tauriのmanaged state)
/// 同じプロファイルでも別タブなら別セッションになる。
/// セッションごとに独立したロック (Arc<Mutex<Session>>) を持つため、
/// あるタブでSQLを実行中でも他のタブは並行して接続・実行できる
#[derive(Default)]
pub struct Sessions(pub Mutex<HashMap<String, Arc<Mutex<Session>>>>);

/// セッションを取り出す。マップ全体のロックは取り出し後すぐ解放されるため、
/// 個別セッションのロック待ちが他セッションの操作を妨げない
async fn get_session(
    sessions: &Sessions,
    session_id: &str,
) -> Result<Arc<Mutex<Session>>, String> {
    sessions
        .0
        .lock()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| "接続されていません。再接続してください".to_string())
}

/// プロファイルのログ表示名
fn conn_label(profile: &ConnectionProfile) -> String {
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

/// 接続を確立してセッションに登録し、DB一覧を返す
pub async fn connect(
    sessions: &Sessions,
    cancel: &CancelRegistry,
    qlog: &QueryLog,
    session_id: String,
    profile: ConnectionProfile,
) -> Result<ConnectInfo, String> {
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
    let database = profile.database.as_deref().filter(|s| !s.is_empty());
    let label = conn_label(&profile);
    qlog.add(&label, "", "-- 接続を確立しました");

    let (mut conn, databases, current_db, server_info) = match profile.db_type {
        DbType::Mysql => {
            let mut c =
                db::connect_mysql(&ep.host, ep.port, &profile.user, &profile.password, database)
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
            let mut c = db::connect_sqlite(&path).await?;
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
            // Valkeyの「データベース名」は論理DB番号 (0-15)
            let db_index: i64 = database.map(|s| s.parse().unwrap_or(0)).unwrap_or(0);
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
            let dbs: Vec<String> = (0..16).map(|i| i.to_string()).collect();
            (DbConn::Kv(c), dbs, Some(db_index.to_string()), info)
        }
    };

    // キャンセル用に接続IDを控えておく
    let conn_id = fetch_conn_id(&mut conn).await?;
    cancel.0.lock().unwrap().insert(
        session_id.clone(),
        CancelTarget {
            db_type: profile.db_type,
            label: label.clone(),
            host: ep.host.clone(),
            port: ep.port,
            user: profile.user.clone(),
            password: profile.password.clone(),
            conn_id,
            tls: profile.tls,
            tls_sni: ep.tunnel.is_some().then(|| profile.host.clone()),
        },
    );

    let session = Session {
        id: session_id.clone(),
        cancel: cancel.clone(),
        host: ep.host.clone(),
        port: ep.port,
        tunnel: ep.tunnel,
        conn,
        current_db: current_db.clone(),
        databases: databases.clone(),
        profile,
        last_used: std::time::Instant::now(),
    };
    // 同じキーで既存セッションがあれば正しく閉じてから置き換える
    let old = sessions
        .0
        .lock()
        .await
        .insert(session_id, Arc::new(Mutex::new(session)));
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
async fn fetch_conn_id(conn: &mut DbConn) -> Result<i64, String> {
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

/// 切断されていた接続を張り直す (SSHトンネル使用時はトンネルごと再構築)
async fn reconnect(session: &mut Session, qlog: &QueryLog) -> Result<(), String> {
    let label = conn_label(&session.profile);
    qlog.add(&label, "", "-- 接続が切れていたため再接続します");

    // SSHトンネル使用時はトンネルも張り直す (ローカルポートが変わる)
    if session.tunnel.is_some() {
        if let Some(t) = session.tunnel.as_mut() {
            t.close().await;
        }
        let ep = db::resolve_endpoint(&session.profile).await?;
        session.host = ep.host;
        session.port = ep.port;
        session.tunnel = ep.tunnel;
    }

    let database = session.current_db.clone();
    let new_conn = match session.profile.db_type {
        DbType::Mysql => DbConn::MySql(
            db::connect_mysql(
                &session.host,
                session.port,
                &session.profile.user,
                &session.profile.password,
                database.as_deref(),
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
            )
            .await?;
            session.current_db = Some(actual_db);
            DbConn::Pg(c)
        }
        DbType::Sqlite => DbConn::Sqlite(db::connect_sqlite(&sqlite_path(&session.profile)).await?),
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

    // 旧接続はほぼ確実に死んでいるが、念のため終了通知を試みる
    let old = std::mem::replace(&mut session.conn, new_conn);
    close_conn_gracefully(old).await;

    // キャンセル用の接続ID・エンドポイントを更新
    if let Ok(conn_id) = fetch_conn_id(&mut session.conn).await {
        if let Some(t) = session.cancel.0.lock().unwrap().get_mut(&session.id) {
            t.conn_id = conn_id;
            t.host = session.host.clone();
            t.port = session.port;
        }
    }

    session.last_used = std::time::Instant::now();
    qlog.add(&label, "", "-- 再接続しました");
    Ok(())
}

/// 操作の前に接続の生存を保証する。
/// しばらく使われていなかった場合はpingし、切れていれば自動で再接続する
async fn ensure_alive(session: &mut Session, qlog: &QueryLog) -> Result<(), String> {
    if session.last_used.elapsed() < IDLE_PING_AFTER {
        session.last_used = std::time::Instant::now();
        return Ok(());
    }
    if ping_conn(&mut session.conn).await {
        session.last_used = std::time::Instant::now();
        return Ok(());
    }
    reconnect(session, qlog).await
}

/// 全セッションに定期pingを送り、アイドル切断を防ぐ (バックグラウンドで定期実行)。
/// pingに失敗しても何もしない (次の操作時にensure_aliveが再接続する)
pub async fn keepalive_all(sessions: &Sessions) {
    // マップのロックはArcの複製だけで即解放し、pingはセッション個別に行う
    let list: Vec<Arc<Mutex<Session>>> =
        sessions.0.lock().await.values().cloned().collect();
    for arc in list {
        // 使用中 (クエリ実行中など) のセッションはスキップ (使われている = 生きている)
        if let Ok(mut session) = arc.try_lock() {
            if ping_conn(&mut session.conn).await {
                session.last_used = std::time::Instant::now();
            }
        }
    }
}

/// 実行中のクエリをキャンセルする。
/// 実行中はセッションの接続が塞がっているため、別接続からKILL/pg_cancel_backendを送る
pub async fn cancel_query(
    cancel: &CancelRegistry,
    qlog: &QueryLog,
    session_id: &str,
) -> Result<(), String> {
    let target = cancel
        .0
        .lock()
        .unwrap()
        .get(session_id)
        .cloned()
        .ok_or("接続されていません")?;

    match target.db_type {
        DbType::Mysql => {
            let mut c =
                db::connect_mysql(&target.host, target.port, &target.user, &target.password, None)
                    .await?;
            let kill = format!("KILL QUERY {}", target.conn_id);
            qlog.add(&target.label, "", &kill);
            sqlx::raw_sql(sqlx::AssertSqlSafe(kill))
                .execute(&mut c)
                .await
                .map_err(db::format_db_error)?;
            let _ = timeout(CLOSE_TIMEOUT, c.close()).await;
        }
        DbType::Postgresql => {
            let (mut c, _) = db::connect_pg_fallback(
                &target.host,
                target.port,
                &target.user,
                &target.password,
                None,
            )
            .await?;
            let sql = format!("SELECT pg_cancel_backend({})", target.conn_id);
            qlog.add(&target.label, "", &sql);
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
                .execute(&mut c)
                .await
                .map_err(db::format_db_error)?;
            let _ = timeout(CLOSE_TIMEOUT, c.close()).await;
        }
        DbType::Sqlite => {
            return Err("SQLite接続では実行中SQLのキャンセルに対応していません".into());
        }
        DbType::Valkey => {
            // CLIENT ID非対応のサーバー (ElastiCache Serverless等) ではキャンセル不可
            if target.conn_id == 0 {
                return Err(
                    "この接続先はコマンドのキャンセルに対応していません".into()
                );
            }
            let mut c = kv::connect(
                &target.host,
                target.port,
                &target.user,
                &target.password,
                0,
                target.tls,
                target.tls_sni.as_deref(),
            )
            .await?;
            let cmd = format!("CLIENT KILL ID {}", target.conn_id);
            qlog.add(&target.label, "", &cmd);
            redis::cmd("CLIENT")
                .arg("KILL")
                .arg("ID")
                .arg(target.conn_id)
                .query_async::<i64>(&mut c)
                .await
                .map_err(kv::format_err)?;
        }
    }
    Ok(())
}

/// 指定データベースのテーブル一覧を返す。
/// PostgreSQLで別DBが指定された場合は接続を張り直す。
pub async fn list_tables(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<Vec<TableInfo>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    let label = conn_label(&session.profile);
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database,
    };

    match &mut session.conn {
        DbConn::MySql(conn) => catalog::mysql_tables(conn, database, &ctx).await,
        DbConn::Pg(_) => {
            ensure_pg_database(session, database, qlog).await?;
            match &mut session.conn {
                DbConn::Pg(conn) => catalog::pg_tables(conn, &ctx).await,
                _ => unreachable!(),
            }
        }
        DbConn::Sqlite(conn) => catalog::sqlite_tables(conn, &ctx).await,
        DbConn::Kv(_) => Err("Valkey接続ではテーブル一覧は使用できません".into()),
    }
}

/// テーブル構造(カラム・インデックス・情報)を返す
pub async fn table_detail(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    schema: Option<String>,
    table: &str,
) -> Result<TableDetail, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    let label = conn_label(&session.profile);
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database,
    };

    match &mut session.conn {
        DbConn::MySql(conn) => catalog::mysql_table_detail(conn, database, table, &ctx).await,
        DbConn::Pg(_) => {
            ensure_pg_database(session, database, qlog).await?;
            let schema = schema.as_deref().unwrap_or("public");
            match &mut session.conn {
                DbConn::Pg(conn) => catalog::pg_table_detail(conn, schema, table, &ctx).await,
                _ => unreachable!(),
            }
        }
        DbConn::Sqlite(conn) => catalog::sqlite_table_detail(conn, table, &ctx).await,
        DbConn::Kv(_) => Err("Valkey接続では使用できません".into()),
    }
}

/// 指定データベースの外部キー一覧を返す (ER図用)
pub async fn foreign_keys(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<Vec<crate::models::FkInfo>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    let label = conn_label(&session.profile);
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database,
    };

    match &mut session.conn {
        DbConn::MySql(conn) => catalog::mysql_foreign_keys(conn, database, &ctx).await,
        DbConn::Pg(_) => {
            ensure_pg_database(session, database, qlog).await?;
            match &mut session.conn {
                DbConn::Pg(conn) => catalog::pg_foreign_keys(conn, &ctx).await,
                _ => unreachable!(),
            }
        }
        DbConn::Sqlite(conn) => catalog::sqlite_foreign_keys(conn, &ctx).await,
        DbConn::Kv(_) => Err("Valkey接続では使用できません".into()),
    }
}

/// 任意のSQLを実行する。複数文はセミコロンで分割して逐次実行し、
/// エラーが出た時点で停止する (offsetは単文実行時のページング用)
/// BEGIN/COMMIT/ROLLBACK等の制御文を実行する
async fn exec_ctl(
    conn: &mut DbConn,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
    sql: &str,
) -> Result<(), String> {
    qlog.add(label, db_label, sql);
    match conn {
        DbConn::MySql(c) => sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(&mut *c)
            .await
            .map(|_| ())
            .map_err(db::format_db_error),
        DbConn::Pg(c) => sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(&mut *c)
            .await
            .map(|_| ())
            .map_err(db::format_db_error),
        DbConn::Sqlite(c) => sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(&mut *c)
            .await
            .map(|_| ())
            .map_err(db::format_db_error),
        DbConn::Kv(_) => Err("Valkey接続では使用できません".into()),
    }
}

/// 選択中のDBに合わせる (MySQLはUSE、PostgreSQLは必要なら接続し直す)
async fn ensure_database(
    session: &mut Session,
    database: Option<&String>,
    qlog: &QueryLog,
    label: &str,
) -> Result<(), String> {
    let Some(db) = database else {
        return Ok(());
    };
    // SQLiteは1ファイル=1DBのため切り替え不要
    if matches!(session.conn, DbConn::Sqlite(_)) {
        return Ok(());
    }
    // MySQL: 選択中DBが変わっていればUSEで切り替える
    if let DbConn::MySql(_) = &session.conn {
        if session.current_db.as_deref() != Some(db.as_str()) {
            let use_sql = format!("USE `{}`", db.replace('`', "``"));
            qlog.add(label, db, &use_sql);
            match &mut session.conn {
                DbConn::MySql(conn) => {
                    sqlx::raw_sql(sqlx::AssertSqlSafe(use_sql.clone()))
                        .execute(&mut *conn)
                        .await
                        .map_err(db::format_db_error)?;
                }
                _ => unreachable!(),
            }
            session.current_db = Some(db.clone());
        }
    } else {
        ensure_pg_database(session, db, qlog).await?;
    }
    Ok(())
}

/// SQL 1文の結果を全件CSVファイルへ書き出す。
/// 画面のページング (1000行) とは無関係に、対象SQLの全行を出力する。
/// jobを渡すと進捗の共有とキャンセルができる。
/// 戻り値は (書き出した行数, キャンセルされたか)
#[allow(clippy::too_many_arguments)]
pub async fn export_query_csv(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: Option<String>,
    sql: &str,
    order_by: Option<String>,
    order_dir: Option<String>,
    path: &std::path::Path,
    job: Option<&crate::csv_job::CsvJob>,
) -> Result<(usize, bool), String> {
    // 並び順 (方向はASC/DESCのみ許可)
    let dir = match order_dir.as_deref() {
        Some("desc") => "DESC",
        _ => "ASC",
    };
    let order = order_by.as_deref().map(|c| (c, dir));

    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    if matches!(session.conn, DbConn::Kv(_)) {
        return Err("Valkey接続ではSQLは実行できません".into());
    }
    let label = conn_label(&session.profile);
    let db_label = database.clone().unwrap_or_default();
    ensure_database(session, database.as_ref(), qlog, &label).await?;

    let mysql_quoting = matches!(session.conn, DbConn::MySql(_));
    let out_sql = query::plan_export(sql, order, mysql_quoting);
    qlog.add(&label, &db_label, &out_sql);

    let file = std::fs::File::create(path).map_err(|e| format!("CSVを作成できません: {e}"))?;
    let mut out = std::io::BufWriter::new(file);
    let (rows, cancelled) = match &mut session.conn {
        DbConn::MySql(conn) => query::export_csv_mysql(conn, &out_sql, &mut out, job).await,
        DbConn::Pg(conn) => query::export_csv_pg(conn, &out_sql, &mut out, job).await,
        DbConn::Sqlite(conn) => query::export_csv_sqlite(conn, &out_sql, &mut out, job).await,
        DbConn::Kv(_) => unreachable!(),
    }?;
    std::io::Write::flush(&mut out).map_err(|e| format!("CSVを書き込めません: {e}"))?;
    Ok((rows, cancelled))
}

#[allow(clippy::too_many_arguments)]
pub async fn run_query(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: Option<String>,
    sql: &str,
    offset: usize,
    order_by: Option<String>,
    order_dir: Option<String>,
    transaction: bool,
    explain: Option<String>,
    timeout_secs: u64,
) -> Result<RunOutput, String> {
    let stmts = query::split_statements(sql);
    if stmts.is_empty() {
        return Err("実行するSQLがありません".into());
    }
    let single = stmts.len() == 1;
    // サーバーサイドソート (方向はASC/DESCのみ許可)
    let dir = match order_dir.as_deref() {
        Some("desc") => "DESC",
        _ => "ASC",
    };
    let order = order_by.as_deref().map(|c| (c, dir));

    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    if matches!(session.conn, DbConn::Kv(_)) {
        return Err("Valkey接続ではSQLは実行できません (コマンドコンソールを使用してください)".into());
    }
    let label = conn_label(&session.profile);
    let db_label = database.clone().unwrap_or_default();

    ensure_database(session, database.as_ref(), qlog, &label).await?;

    // トランザクション実行: 全文成功でCOMMIT、途中エラーでROLLBACK
    if transaction {
        exec_ctl(&mut session.conn, qlog, &label, &db_label, "BEGIN").await?;
    }

    let mysql_quoting = matches!(session.conn, DbConn::MySql(_));
    let mut statements: Vec<StatementResult> = Vec::new();
    for (i, stmt) in stmts.iter().enumerate() {
        let plan = if let Some(mode) = &explain {
            // EXPLAIN / EXPLAIN ANALYZE モード: 文の先頭にプレフィックスを付けて
            // ページングやソートは行わずそのまま取得する
            let prefix = if matches!(session.conn, DbConn::Sqlite(_)) {
                // SQLiteのEXPLAINはバイトコードが出るだけなので、
                // 読みやすいEXPLAIN QUERY PLANを使う (ANALYZEは無い)
                "EXPLAIN QUERY PLAN "
            } else if mode == "analyze" {
                "EXPLAIN ANALYZE "
            } else {
                "EXPLAIN "
            };
            query::PlannedQuery {
                sql: format!("{prefix}{stmt}"),
                is_fetch: true,
                pageable: false,
                offset: 0,
                order_by: None,
                order_dir: None,
            }
        } else {
            query::plan(
                stmt,
                if single { offset } else { 0 },
                if single { order } else { None },
                mysql_quoting,
            )
        };
        qlog.add(&label, &db_label, &plan.sql);

        let res = match &mut session.conn {
            DbConn::MySql(conn) => query::run_mysql(conn, &plan, timeout_secs).await,
            DbConn::Pg(conn) => query::run_pg(conn, &plan, timeout_secs).await,
            DbConn::Sqlite(conn) => query::run_sqlite(conn, &plan, timeout_secs).await,
            DbConn::Kv(_) => unreachable!(),
        };

        match res {
            Ok(r) => {
                statements.push(StatementResult {
                    sql: stmt.clone(),
                    result: r,
                });
            }
            Err(e) => {
                let mut msg = if single {
                    e
                } else {
                    format!("{}文目でエラー: {e}", i + 1)
                };
                if transaction {
                    match exec_ctl(&mut session.conn, qlog, &label, &db_label, "ROLLBACK")
                        .await
                    {
                        Ok(()) => {
                            msg = format!("{msg}\nロールバックしました (変更はすべて取り消されました)");
                        }
                        Err(re) => {
                            msg = format!("{msg}\nロールバックにも失敗しました: {re}");
                        }
                    }
                }
                return Ok(RunOutput {
                    statements,
                    error: Some(msg),
                    failed_index: Some(i),
                });
            }
        }
    }

    if transaction {
        exec_ctl(&mut session.conn, qlog, &label, &db_label, "COMMIT").await?;
    }

    Ok(RunOutput {
        statements,
        error: None,
        failed_index: None,
    })
}

/// 指定DBの全テーブルのスキーマ情報 (テーブル+カラム+インデックス) を収集する
async fn collect_schema_inner(
    session: &mut Session,
    qlog: &QueryLog,
    database: &str,
) -> Result<Vec<SchemaEntry>, String> {
    let label = conn_label(&session.profile);
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database,
    };

    // テーブル一覧
    let tables = match &mut session.conn {
        DbConn::MySql(conn) => catalog::mysql_tables(conn, database, &ctx).await?,
        DbConn::Pg(_) => {
            ensure_pg_database(session, database, qlog).await?;
            match &mut session.conn {
                DbConn::Pg(conn) => catalog::pg_tables(conn, &ctx).await?,
                _ => unreachable!(),
            }
        }
        DbConn::Sqlite(conn) => catalog::sqlite_tables(conn, &ctx).await?,
        DbConn::Kv(_) => return Err("Valkey接続では使用できません".into()),
    };

    // テーブルごとの詳細
    let mut items = Vec::with_capacity(tables.len());
    for t in &tables {
        let detail = match &mut session.conn {
            DbConn::MySql(conn) => {
                catalog::mysql_table_detail(conn, database, &t.name, &ctx).await?
            }
            DbConn::Pg(conn) => {
                let schema = t.schema.as_deref().unwrap_or("public");
                catalog::pg_table_detail(conn, schema, &t.name, &ctx).await?
            }
            DbConn::Sqlite(conn) => catalog::sqlite_table_detail(conn, &t.name, &ctx).await?,
            DbConn::Kv(_) => return Err("Valkey接続では使用できません".into()),
        };
        items.push(SchemaEntry {
            table: t.clone(),
            detail,
        });
    }
    Ok(items)
}

/// スキーマスナップショットを返す (差分ビューア用)
pub async fn schema_snapshot(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<Vec<SchemaEntry>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    collect_schema_inner(session, qlog, database).await
}

/// 開いているセッションの一覧 (差分ビューアの選択肢用)
pub async fn list_sessions(sessions: &Sessions) -> Vec<SessionSummary> {
    let entries: Vec<(String, Arc<Mutex<Session>>)> = sessions
        .0
        .lock()
        .await
        .iter()
        .map(|(id, arc)| (id.clone(), arc.clone()))
        .collect();
    let mut list = Vec::with_capacity(entries.len());
    for (id, arc) in entries {
        // クエリ実行中のセッションはロック待ちせずスキップする
        // (一覧のために実行完了を待たない。完了後の再取得で表示される)
        if let Ok(s) = arc.try_lock() {
            list.push(SessionSummary {
                session_id: id,
                profile_id: s.profile.id.clone(),
                name: conn_label(&s.profile),
                db_type: s.profile.db_type,
                databases: s.databases.clone(),
                current_db: s.current_db.clone(),
            });
        }
    }
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list
}

/// 外部ツール(mysqldump等)用の接続エンドポイント情報を返す。
/// SSHトンネル使用時は解決済みの127.0.0.1:ローカルポートになる
pub async fn endpoint_info(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
) -> Result<crate::tools::Endpoint, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let s = &mut *guard;
    // SSHトンネルが切れているとローカルポートが無効なため、先に生存確認する
    ensure_alive(s, qlog).await?;
    Ok(crate::tools::Endpoint {
        db_type: s.profile.db_type,
        host: s.host.clone(),
        port: s.port,
        user: s.profile.user.clone(),
        password: s.profile.password.clone(),
    })
}

/// 選択中DBの全テーブルの定義・カラム・インデックスをCSV文字列で返す
/// (tables.csv, columns.csv, indexes.csv の3つ)
pub async fn export_schema(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    comment_delimiter: &str,
) -> Result<(String, String, String), String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    let items = collect_schema_inner(session, qlog, database).await?;

    Ok((
        export::tables_csv(&items),
        export::columns_csv(&items, comment_delimiter),
        export::indexes_csv(&items),
    ))
}

/// PostgreSQLで指定DBに接続していなければ張り直す
async fn ensure_pg_database(
    session: &mut Session,
    database: &str,
    qlog: &QueryLog,
) -> Result<(), String> {
    if session.current_db.as_deref() != Some(database) {
        qlog.add(
            &conn_label(&session.profile),
            database,
            &format!("-- データベース '{database}' に接続を切り替え"),
        );
        let new_conn = db::connect_pg(
            &session.host,
            session.port,
            &session.profile.user,
            &session.profile.password,
            Some(database),
        )
        .await?;
        // 旧接続はTerminateを送って閉じる
        let old = std::mem::replace(&mut session.conn, DbConn::Pg(new_conn));
        close_conn_gracefully(old).await;
        session.current_db = Some(database.to_string());
        // 接続が変わったのでキャンセル用の接続IDを更新する
        if let Ok(conn_id) = fetch_conn_id(&mut session.conn).await {
            if let Some(t) = session.cancel.0.lock().unwrap().get_mut(&session.id) {
                t.conn_id = conn_id;
            }
        }
    }
    Ok(())
}

/// DB接続に終了通知(COM_QUIT / Terminate)を送って閉じる
async fn close_conn_gracefully(conn: DbConn) {
    match conn {
        DbConn::MySql(c) => {
            let _ = timeout(CLOSE_TIMEOUT, c.close()).await;
        }
        DbConn::Pg(c) => {
            let _ = timeout(CLOSE_TIMEOUT, c.close()).await;
        }
        DbConn::Sqlite(c) => {
            let _ = timeout(CLOSE_TIMEOUT, c.close()).await;
        }
        // Valkeyはdropで切断される (明示的な終了通知は不要)
        DbConn::Kv(_) => {}
    }
}

/// セッション全体を正しく閉じる (DB終了通知 → SSH Disconnect通知)
async fn close_session_gracefully(mut session: Session, qlog: &QueryLog) {
    let label = conn_label(&session.profile);
    close_conn_gracefully(session.conn).await;
    if let Some(tunnel) = session.tunnel.as_mut() {
        tunnel.close().await;
    }
    qlog.add(&label, "", "-- 切断しました (終了通知を送信)");
}

/// Arcに包まれたセッションを、他で使用中でなければ正しく閉じる。
/// クエリ実行中など使用中の場合は、その処理の完了時 (Arc解放時) に
/// 接続ごと破棄される (終了通知は送られない)
async fn close_session_arc(arc: Arc<Mutex<Session>>, qlog: &QueryLog) {
    if let Ok(m) = Arc::try_unwrap(arc) {
        close_session_gracefully(m.into_inner(), qlog).await;
    }
}

// ---------- Valkey (KV) セッション操作 ----------

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
) -> Result<kv::KvRunOutput, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    ensure_kv_db(session, database, qlog).await?;
    let label = conn_label(&session.profile);
    for c in &commands {
        qlog.add(&label, database, c);
    }
    match &mut session.conn {
        DbConn::Kv(c) => kv::exec(c, &commands).await,
        _ => Err("Valkey接続ではありません".into()),
    }
}

/// セッションを破棄する。DB・SSHとも終了通知を送ってから閉じる
pub async fn disconnect(sessions: &Sessions, qlog: &QueryLog, session_id: &str) {
    let removed = sessions.0.lock().await.remove(session_id);
    if let Some(arc) = removed {
        match Arc::try_unwrap(arc) {
            Ok(m) => {
                let session = m.into_inner();
                session.cancel.0.lock().unwrap().remove(session_id);
                close_session_gracefully(session, qlog).await;
            }
            // クエリ実行中に切断された場合: 実行タスクの完了時にArcごと破棄される
            Err(_) => {}
        }
    }
}
