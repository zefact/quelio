use std::time::Instant;

use sqlx::mysql::{MySqlConnection, MySqlConnectOptions};
use sqlx::postgres::{PgConnection, PgConnectOptions};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::{ConnectOptions, Connection};
use tokio::time::{timeout, Duration};

use crate::models::{ConnectionProfile, DbType, TestResult};
use crate::query_log::QueryLog;
use crate::ssh_tunnel::{self, SshTunnel};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// 実際に接続するホスト・ポート(SSHトンネル経由の場合はローカル転送先)
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    /// トンネルを使う場合は生存させ続ける必要がある
    pub tunnel: Option<SshTunnel>,
}

/// プロファイルから接続先エンドポイントを解決する(必要ならSSHトンネルを張る)
pub async fn resolve_endpoint(p: &ConnectionProfile) -> Result<Endpoint, String> {
    match &p.ssh {
        Some(ssh) if ssh.enabled => {
            let t = timeout(
                CONNECT_TIMEOUT,
                ssh_tunnel::open_tunnel(ssh, p.host.clone(), p.port),
            )
            .await
            .map_err(|_| "SSH接続がタイムアウトしました".to_string())??;
            Ok(Endpoint {
                host: "127.0.0.1".into(),
                port: t.local_port,
                tunnel: Some(t),
            })
        }
        _ => Ok(Endpoint {
            host: p.host.clone(),
            port: p.port,
            tunnel: None,
        }),
    }
}

pub async fn connect_mysql(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: Option<&str>,
) -> Result<MySqlConnection, String> {
    let mut opts = MySqlConnectOptions::new()
        .host(host)
        .port(port)
        .username(user)
        .password(password);
    if let Some(db) = database {
        opts = opts.database(db);
    }
    timeout(CONNECT_TIMEOUT, opts.connect())
        .await
        .map_err(|_| "DB接続がタイムアウトしました".to_string())?
        .map_err(format_db_error)
}

pub async fn connect_pg(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: Option<&str>,
) -> Result<PgConnection, String> {
    let mut opts = PgConnectOptions::new()
        .host(host)
        .port(port)
        .username(user)
        .password(password);
    if let Some(db) = database {
        opts = opts.database(db);
    }
    timeout(CONNECT_TIMEOUT, opts.connect())
        .await
        .map_err(|_| "DB接続がタイムアウトしました".to_string())?
        .map_err(format_db_error)
}

/// SQLiteのデータベースファイルを開く。
/// 打ち間違いで空のDBができないよう、存在しないファイルはエラーにする
pub async fn connect_sqlite(path: &str) -> Result<SqliteConnection, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("データベースファイルを指定してください".into());
    }
    let file = std::path::Path::new(path);
    if !file.is_file() {
        return Err(format!(
            "データベースファイルが見つかりません: {path}\n(新規作成はしません。既存のファイルを指定してください)"
        ));
    }
    let opts = SqliteConnectOptions::new()
        .filename(file)
        .create_if_missing(false)
        // 外部キー制約を有効にする (ER図・整合性チェック用)
        .foreign_keys(true);
    timeout(CONNECT_TIMEOUT, opts.connect())
        .await
        .map_err(|_| "DB接続がタイムアウトしました".to_string())?
        .map_err(format_db_error)
}

/// PostgreSQLはどこかのDBに接続する必要があるため、
/// 未指定時は候補を順に試す: 指定DB → postgres → ユーザー名 → template1。
/// 成功した接続と実際に接続したDB名を返す。
pub async fn connect_pg_fallback(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    preferred: Option<&str>,
) -> Result<(PgConnection, String), String> {
    let mut candidates: Vec<&str> = Vec::new();
    if let Some(db) = preferred.filter(|s| !s.is_empty()) {
        candidates.push(db);
    } else {
        candidates.extend(["postgres", user, "template1"]);
    }
    candidates.dedup();

    let mut last_err = String::new();
    for db in candidates {
        match connect_pg(host, port, user, password, Some(db)).await {
            Ok(conn) => return Ok((conn, db.to_string())),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

/// 接続テストを実行して結果を返す(エラーもTestResultに畳み込む)
pub async fn run_test(profile: ConnectionProfile, qlog: &QueryLog) -> TestResult {
    let started = Instant::now();
    match test_inner(&profile, qlog).await {
        Ok(version) => TestResult {
            success: true,
            message: "接続に成功しました".into(),
            server_version: Some(version),
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
        Err(message) => TestResult {
            success: false,
            message,
            server_version: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
    }
}

async fn test_inner(p: &ConnectionProfile, qlog: &QueryLog) -> Result<String, String> {
    // SQLiteはローカルファイルなので、エンドポイント解決 (SSHトンネル) は行わない
    if p.db_type == DbType::Sqlite {
        let path = p.database.as_deref().unwrap_or("");
        let mut conn = connect_sqlite(path).await?;
        let label: &str = if p.name.is_empty() {
            path
        } else {
            p.name.as_str()
        };
        qlog.add(label, path, "SELECT sqlite_version()");
        let version: String = sqlx::query_scalar("SELECT sqlite_version()")
            .fetch_one(&mut conn)
            .await
            .map_err(format_db_error)?;
        let _ = conn.close().await;
        return Ok(format!("SQLite {version}"));
    }

    let mut ep = resolve_endpoint(p).await?;
    let database = p.database.as_deref().filter(|s| !s.is_empty());
    let label = if p.name.is_empty() {
        format!("{}:{}", p.host, p.port)
    } else {
        p.name.clone()
    };

    let result = async {
        match p.db_type {
            DbType::Mysql => {
                let mut conn =
                    connect_mysql(&ep.host, ep.port, &p.user, &p.password, database).await?;
                qlog.add(&label, database.unwrap_or(""), "SELECT VERSION()");
                let version: String = sqlx::query_scalar("SELECT VERSION()")
                    .fetch_one(&mut conn)
                    .await
                    .map_err(format_db_error)?;
                // COM_QUITを送って正しく切断する
                let _ = conn.close().await;
                Ok(format!("MySQL {version}"))
            }
            DbType::Postgresql => {
                let (mut conn, db) =
                    connect_pg_fallback(&ep.host, ep.port, &p.user, &p.password, database)
                        .await?;
                qlog.add(&label, &db, "SHOW server_version");
                let version: String = sqlx::query_scalar("SHOW server_version")
                    .fetch_one(&mut conn)
                    .await
                    .map_err(format_db_error)?;
                // Terminateメッセージを送って正しく切断する
                let _ = conn.close().await;
                Ok(format!("PostgreSQL {version}"))
            }
            // SQLiteは関数の先頭で処理済み
            DbType::Sqlite => unreachable!(),
            DbType::Valkey => {
                let db_index: i64 = database.and_then(|s| s.parse().ok()).unwrap_or(0);
                let mut conn = crate::kv::connect(
                    &ep.host,
                    ep.port,
                    &p.user,
                    &p.password,
                    db_index,
                    p.tls,
                    ep.tunnel.is_some().then_some(p.host.as_str()),
                )
                .await
                .map_err(|e| {
                    ep.tunnel
                        .as_ref()
                        .and_then(|t| t.take_error())
                        .unwrap_or(e)
                })?;
                qlog.add(&label, "", "INFO");
                let info = crate::kv::server_info(&mut conn).await?;
                let version = info
                    .iter()
                    .find(|(l, _)| l == "バージョン")
                    .map(|(_, v)| v.clone())
                    .unwrap_or_else(|| "Valkey".to_string());
                Ok(version)
            }
        }
    }
    .await;

    // SSHトンネルもDisconnect通知を送ってから閉じる
    if let Some(tunnel) = ep.tunnel.as_mut() {
        tunnel.close().await;
    }

    result
}

pub fn format_db_error(e: sqlx::Error) -> String {
    match &e {
        sqlx::Error::Database(db_err) => format!("DBエラー: {db_err}"),
        sqlx::Error::Io(io_err) => format!("接続できません: {io_err}"),
        sqlx::Error::Tls(tls_err) => format!("TLSエラー: {tls_err}"),
        _ => format!("エラー: {e}"),
    }
}
