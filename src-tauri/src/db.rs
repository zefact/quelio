use std::time::Instant;

use sqlx::mysql::{MySqlConnectOptions, MySqlConnection, MySqlSslMode};
use sqlx::postgres::{PgConnectOptions, PgConnection, PgSslMode};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::{ConnectOptions, Connection};
use tokio::time::{timeout, Duration};

use crate::apperr::{AppError, ErrKind};
use crate::models::{ConnectionProfile, DbType, TestResult};
use crate::query_log::QueryLog;
use crate::proxy::{self, Forwarder};
use crate::ssh_tunnel;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// 実際に接続するホスト・ポート(トンネル経由の場合はローカル転送先)
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    /// トンネルを使う場合は生存させ続ける必要がある
    pub tunnel: Option<Forwarder>,
}

/// ローカル転送を使うときのエンドポイント
fn local(f: Forwarder) -> Endpoint {
    Endpoint {
        host: "127.0.0.1".into(),
        port: f.local_port(),
        tunnel: Some(f),
    }
}

/// プロファイルから接続先エンドポイントを解決する。
///
/// 外部CLI経由 (SSM / Cloud SQL) とSSHトンネルは同時には使わない。
/// 設定が両方あってもCLI側を優先する (画面ではどちらか一方しか立たない)
pub async fn resolve_endpoint(p: &ConnectionProfile) -> Result<Endpoint, String> {
    if let Some(px) = p.proxy.as_ref().filter(|x| x.enabled) {
        let proc = proxy::start(px, &p.host, p.port).await?;
        return Ok(local(Forwarder::Cli(proc)));
    }
    match &p.ssh {
        Some(ssh) if ssh.enabled => {
            let t = timeout(
                CONNECT_TIMEOUT,
                ssh_tunnel::open_tunnel(ssh, p.host.clone(), p.port),
            )
            .await
            .map_err(|_| "SSH接続がタイムアウトしました".to_string())??;
            Ok(local(Forwarder::Ssh(t)))
        }
        _ => Ok(Endpoint {
            host: p.host.clone(),
            port: p.port,
            tunnel: None,
        }),
    }
}

/// クライアント証明書の指定が片方だけのときの案内
const CLIENT_CERT_PAIR_MSG: &str =
    "クライアント証明書と秘密鍵は、両方そろえて指定してください";

/// TLSの使い方 (MySQL / PostgreSQL 共通)
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum SslMode {
    /// ドライバの既定 (使えれば使う・証明書は検証しない)
    Default,
    /// TLSを使わない
    Disable,
    /// 必ずTLSを使う (証明書は検証しない)
    Require,
    /// CA証明書まで検証する
    VerifyCa,
    /// CA証明書とホスト名まで検証する
    VerifyFull,
}

impl SslMode {
    /// 保存値 (文字列) から作る。未設定・未知の値は既定として扱う
    pub fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("").trim() {
            "disable" => SslMode::Disable,
            "require" => SslMode::Require,
            "verify-ca" => SslMode::VerifyCa,
            "verify-full" => SslMode::VerifyFull,
            _ => SslMode::Default,
        }
    }

    /// 画面・ログに出す短い表記
    pub fn label(self) -> &'static str {
        match self {
            SslMode::Default => "TLS=既定",
            SslMode::Disable => "TLS=なし",
            SslMode::Require => "TLS=必須",
            SslMode::VerifyCa => "TLS=CA検証",
            SslMode::VerifyFull => "TLS=CA+ホスト名検証",
        }
    }
}

/// 接続に使うTLS設定 (プロファイルから作る)
#[derive(Clone)]
pub struct TlsConfig {
    pub mode: SslMode,
    pub ca: Option<String>,
    pub client_cert: Option<String>,
    pub client_key: Option<String>,
    /// SSHトンネル経由か (接続先が127.0.0.1になり、ホスト名の検証ができない)
    pub via_tunnel: bool,
}

impl TlsConfig {
    pub fn from_profile(p: &ConnectionProfile, via_tunnel: bool) -> Self {
        let opt = |v: &Option<String>| v.clone().filter(|s| !s.trim().is_empty());
        TlsConfig {
            mode: SslMode::parse(p.ssl_mode.as_deref()),
            ca: opt(&p.ca_cert_path),
            client_cert: opt(&p.client_cert_path),
            client_key: opt(&p.client_key_path),
            via_tunnel,
        }
    }

    /// SSHトンネル経由ではホスト名を検証できないため、CA検証までに落とす。
    /// 外部ツール (mysqldump 等) に渡す指定でも同じ扱いにする
    pub(crate) fn effective_mode(&self) -> SslMode {
        if self.via_tunnel && self.mode == SslMode::VerifyFull {
            SslMode::VerifyCa
        } else {
            self.mode
        }
    }
}

impl Default for TlsConfig {
    fn default() -> Self {
        TlsConfig {
            mode: SslMode::Default,
            ca: None,
            client_cert: None,
            client_key: None,
            via_tunnel: false,
        }
    }
}

pub async fn connect_mysql(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: Option<&str>,
    tls: &TlsConfig,
) -> Result<MySqlConnection, String> {
    let mut opts = MySqlConnectOptions::new()
        .host(host)
        .port(port)
        .username(user)
        .password(password);
    if let Some(db) = database {
        opts = opts.database(db);
    }
    opts = match tls.effective_mode() {
        SslMode::Default => opts,
        SslMode::Disable => opts.ssl_mode(MySqlSslMode::Disabled),
        SslMode::Require => opts.ssl_mode(MySqlSslMode::Required),
        SslMode::VerifyCa => opts.ssl_mode(MySqlSslMode::VerifyCa),
        SslMode::VerifyFull => opts.ssl_mode(MySqlSslMode::VerifyIdentity),
    };
    // CA証明書は検証するモードのときだけ意味がある
    if let (Some(ca), SslMode::VerifyCa | SslMode::VerifyFull) = (&tls.ca, tls.effective_mode()) {
        opts = opts.ssl_ca(ca);
    }
    match (&tls.client_cert, &tls.client_key) {
        (Some(cert), Some(key)) => opts = opts.ssl_client_cert(cert).ssl_client_key(key),
        (None, None) => {}
        // 片方だけでは認証できないので、黙って無視せずエラーにする
        _ => return Err(CLIENT_CERT_PAIR_MSG.to_string()),
    }
    timeout(CONNECT_TIMEOUT, opts.connect())
        .await
        .map_err(|_| crate::apperr::timeout_message("DB接続"))?
        .map_err(format_db_error)
}

pub async fn connect_pg(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: Option<&str>,
    tls: &TlsConfig,
) -> Result<PgConnection, String> {
    let mut opts = PgConnectOptions::new()
        .host(host)
        .port(port)
        .username(user)
        .password(password);
    if let Some(db) = database {
        opts = opts.database(db);
    }
    opts = match tls.effective_mode() {
        SslMode::Default => opts,
        SslMode::Disable => opts.ssl_mode(PgSslMode::Disable),
        SslMode::Require => opts.ssl_mode(PgSslMode::Require),
        SslMode::VerifyCa => opts.ssl_mode(PgSslMode::VerifyCa),
        SslMode::VerifyFull => opts.ssl_mode(PgSslMode::VerifyFull),
    };
    if let (Some(ca), SslMode::VerifyCa | SslMode::VerifyFull) = (&tls.ca, tls.effective_mode()) {
        opts = opts.ssl_root_cert(ca);
    }
    match (&tls.client_cert, &tls.client_key) {
        (Some(cert), Some(key)) => opts = opts.ssl_client_cert(cert).ssl_client_key(key),
        (None, None) => {}
        _ => return Err(CLIENT_CERT_PAIR_MSG.to_string()),
    }
    timeout(CONNECT_TIMEOUT, opts.connect())
        .await
        .map_err(|_| crate::apperr::timeout_message("DB接続"))?
        .map_err(format_db_error)
}

/// SQLiteのデータベースファイルを開く。
/// 打ち間違いで空のDBができないよう、存在しないファイルはエラーにする
pub async fn connect_sqlite(path: &str, read_only: bool) -> Result<SqliteConnection, String> {
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
        // 読み取り専用の接続では、SQLite自体を読み取り専用で開く
        .read_only(read_only)
        // 外部キー制約を有効にする (ER図・整合性チェック用)
        .foreign_keys(true);
    timeout(CONNECT_TIMEOUT, opts.connect())
        .await
        .map_err(|_| crate::apperr::timeout_message("DB接続"))?
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
    tls: &TlsConfig,
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
        match connect_pg(host, port, user, password, Some(db), tls).await {
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
        let mut conn = connect_sqlite(path, p.read_only).await?;
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
                let tls = TlsConfig::from_profile(p, ep.tunnel.is_some());
                let mut conn =
                    connect_mysql(&ep.host, ep.port, &p.user, &p.password, database, &tls).await?;
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
                let tls = TlsConfig::from_profile(p, ep.tunnel.is_some());
                let (mut conn, db) =
                    connect_pg_fallback(&ep.host, ep.port, &p.user, &p.password, database, &tls)
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

/// SQLiteが「中断された」ときの結果コード (SQLITE_INTERRUPT)。
/// MySQL・PostgreSQLのコードは5文字のSQLSTATEなので取り違えない
const SQLITE_INTERRUPT: &str = "9";

/// 「中止」を押した結果であることを表す説明。
/// 呼び出し側がこの文字列で見分けるので、変えるときは合わせて直すこと
pub const CANCELLED_MSG: &str = "実行を中止しました";

/// 実行が途中で打ち切られたエラーなら、その説明を返す。
///
/// `DatabaseError::code()` が返すのは、MySQL・PostgreSQLではSQLSTATE、
/// SQLiteでは結果コードの数値。
/// MySQLの `KILL QUERY` は 70100、PostgreSQLの `pg_cancel_backend` は 57014、
/// SQLiteはプログレスハンドラで打ち切ると 9 になる。
/// SQLSTATEの方は同じコードがサーバー側のタイムアウトでも返るため、
/// 「自分で中止した」と言い切れない場合は元の説明を添える
fn cancelled_message(e: &dyn sqlx::error::DatabaseError) -> Option<String> {
    if e.code().as_deref() == Some(SQLITE_INTERRUPT) {
        return Some(CANCELLED_MSG.to_string());
    }
    if !matches!(e.code().as_deref(), Some("70100") | Some("57014")) {
        return None;
    }
    let msg = e.message();
    let lower = msg.to_ascii_lowercase();
    // 例: canceling statement due to statement timeout (PostgreSQL)
    //     Query execution was interrupted (max_statement_time exceeded) (MariaDB)
    if ["timeout", "timed out", "exceeded"]
        .iter()
        .any(|w| lower.contains(w))
    {
        return Some(format!("サーバー側で打ち切られました: {msg}"));
    }
    Some(CANCELLED_MSG.to_string())
}

/// 「そもそもトランザクションが開いていない」という応答か。
///
/// COMMIT / ROLLBACK の後始末では、これは失敗ではなく目的達成とみなす。
/// 文言はDBが返す英語なので、こちらでは変えられない
pub fn is_no_txn_message(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("no transaction") || m.contains("no active transaction")
}

/// sqlxのエラーを、種類つきのアプリのエラーにする。
///
/// 後始末の分かれ道 (中止・タイムアウト・トランザクション無し) は、
/// ここで一度だけ見分けて型に持たせる
pub fn db_error(e: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db_err) = &e {
        if let Some(msg) = cancelled_message(db_err.as_ref()) {
            // 同じSQLSTATEでも、サーバー側のタイムアウトは中止とは別に扱う
            let kind = if msg == CANCELLED_MSG {
                ErrKind::Cancelled
            } else {
                ErrKind::Timeout
            };
            return AppError::new(kind, msg);
        }
    }
    let msg = format_db_error(e);
    if is_no_txn_message(&msg) {
        AppError::new(ErrKind::NoTxn, msg)
    } else {
        AppError::other(msg)
    }
}

pub fn format_db_error(e: sqlx::Error) -> String {
    // 自分で「中止」を押した結果までエラー扱いにしない
    if let sqlx::Error::Database(db_err) = &e {
        if let Some(msg) = cancelled_message(db_err.as_ref()) {
            return msg;
        }
    }
    match &e {
        sqlx::Error::Database(db_err) => format!("DBエラー: {db_err}"),
        sqlx::Error::Io(io_err) => format!("接続できません: {io_err}"),
        sqlx::Error::Tls(tls_err) => format!("TLSエラー: {tls_err}"),
        _ => format!("エラー: {e}"),
    }
}
