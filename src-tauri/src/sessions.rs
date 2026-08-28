//! アクティブなDB接続(セッション)の管理

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
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
/// 定期実行のなかでトランザクションを後始末するときの上限時間
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(30);
/// 設定を触った後に方言を聞き直すときの上限時間
const DIALECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 実行中クエリをキャンセルするための接続情報。
/// パスワードを持つので、捨てるときにメモリを0で潰す (Zeroizing)
#[derive(Clone)]
pub struct CancelTarget {
    pub db_type: DbType,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: zeroize::Zeroizing<String>,
    /// MySQL: CONNECTION_ID() / PostgreSQL: pg_backend_pid()
    pub conn_id: i64,
    /// Valkey: TLSで接続するか (キャンセル用の別接続にも同じ設定を使う)
    pub tls: bool,
    /// Valkey: TLSのSNI/証明書検証に使う本来のホスト名 (SSHトンネル経由時)
    pub tls_sni: Option<String>,
    /// MySQL / PostgreSQL: キャンセル用の別接続にも同じTLS設定を使う
    pub db_tls: db::TlsConfig,
    /// SQLite: 実行中の処理に中止を伝えるための印。
    /// SQLiteには別接続からKILLを送る相手がいないので、
    /// 実行しているコネクション自身に見てもらう
    pub sqlite_cancel: Option<Arc<std::sync::atomic::AtomicBool>>,
}

/// セッションID → キャンセル対象 (クエリ実行中でも参照できるよう独立したロック)
#[derive(Default, Clone)]
pub struct CancelRegistry(pub std::sync::Arc<std::sync::Mutex<HashMap<String, CancelTarget>>>);

/// セッションのトランザクション (txn) の状態。
///
/// 未コミットのトランザクションを次の操作へ持ち越すと、変更が確定してしまう。
/// 経路はDBで違う:
/// MySQLは `BEGIN` が開いていたトランザクションを暗黙コミットし、
/// PostgreSQLは `BEGIN` が無視されて外側のトランザクションが続くため
/// 次の `COMMIT` で一緒に確定する
/// (SQLiteだけは「入れ子にできない」というエラーになり安全側に倒れる)。
/// 開いたままかどうかを覚えておき、次の操作の入口で後始末する
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TxnState {
    /// トランザクションの外
    None,
    /// Quelioが張ったトランザクション (COMMIT / ROLLBACK 待ち)。
    /// 通常は同じ操作の中で閉じるので、これが次の操作まで残るのは
    /// 処理が途中で打ち切られた場合だけ
    Open,
    /// 後始末 (COMMIT / ROLLBACK) に失敗した。この接続はもう信用できない
    Broken,
    /// 利用者がSQLに自分で書いた `BEGIN` で開いたトランザクション。
    /// 「1回目に BEGIN、2回目に COMMIT」という使い方は正当なので勝手に閉じない。
    /// ただしこの上に Quelio がトランザクションを重ねることはできない
    User,
}

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
    /// この接続で実際に通用するSQLの書き方 (サーバー設定から解決したもの)。
    /// 接続を張り直したら必ず解決し直す
    dialect: query::Dialect,
    /// Quelioが張ったトランザクションの状態 (利用者がSQLに直接書いた
    /// BEGIN は対象外)。開いたままなら次の操作の入口で接続を張り直す
    txn: TxnState,
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

/// 中止対象のDBの種類を返す (未接続ならNone)。
/// セッションのロックを取らないので、処理の実行中でも読める
pub fn cancel_target_db(cancel: &CancelRegistry, session_id: &str) -> Option<DbType> {
    cancel
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(session_id)
        .map(|t| t.db_type)
}

/// セッションが実際に使っている方言を返す (未接続ならNone)。
/// 危険なSQLの判定など、接続を使わない処理から参照するためのもの
pub async fn session_dialect(sessions: &Sessions, session_id: &str) -> Option<query::Dialect> {
    let arc = sessions.0.lock().await.get(session_id).cloned()?;
    // クエリ実行中はセッションのロックが長時間掴まれたままになる。
    // 方言を1つ読むためだけに待つと画面が止まるので、取れなければ諦める
    // (呼び出し側が安全側の方言で判定し直す)
    arc.try_lock().ok().map(|s| s.dialect)
}

/// 読み取り専用の接続で変更しようとしたときの案内
pub const READ_ONLY_MSG: &str = concat!(
    "この接続は読み取り専用です。\n",
    "変更するには、接続先の設定で「読み取り専用」を外して接続し直してください。"
);

/// 行ロックを取るSQLを断るときの説明。
/// データは変わらないため、READ_ONLY_MSG だけでは理由が伝わらない
pub const ROW_LOCK_MSG: &str = concat!(
    "この接続は読み取り専用です。\n",
    "FOR UPDATE / LOCK IN SHARE MODE や GET_LOCK / pg_advisory_lock は、\n",
    "データは変わりませんが\n",
    "対象の行にロックを掛けるため実行できません。\n",
    "必要な場合は、接続先の設定で「読み取り専用」を外して接続し直してください。"
);

/// 引用符・コメントが閉じられていないSQLを断るときの説明。
/// 方言の見立てがサーバーと食い違っていると起きるため、
/// 読み取り専用の接続では「1文かどうか分からないSQL」は実行しない
pub const UNTERMINATED_MSG: &str = concat!(
    "SQLの引用符またはコメントが閉じられていないため、\n",
    "どこまでが1つのSQLなのか判断できません。\n",
    "この接続は読み取り専用なので、判断できないSQLは実行しません。\n",
    "引用符やコメントを閉じてから実行し直してください。"
);

/// SQLを文単位に分割する。読み取り専用の接続では、
/// 分割が不完全でないか・すべての文が参照系かをここで確かめる。
///
/// 分割にはセッションが実際に使っている方言を使うため、
/// 接続が定まった後 (ensure_database の後) に呼ぶこと
fn split_checked(session: &Session, sql: &str) -> Result<Vec<String>, String> {
    let d = session.dialect;
    let split = query::split_sql(d, sql);
    if session.profile.read_only {
        // 閉じ忘れがあると文の切れ目を見誤るため、そのまま実行はしない
        if let Some(reason) = &split.unterminated {
            return Err(format!("{UNTERMINATED_MSG}\n\n{reason}"));
        }
        // 複数文をまとめて渡されても素通りしないよう、文ごとに見る
        if let Some(bad) = split.stmts.iter().find(|s| !query::is_read_only(d, s)) {
            let head: String = bad.chars().take(60).collect();
            // ロックが理由のときは、そうと分かる説明にする
            let msg = if query::locks_rows(d, bad) {
                ROW_LOCK_MSG
            } else {
                READ_ONLY_MSG
            };
            return Err(format!("{msg}\n\n対象: {head}"));
        }
    }
    Ok(split.stmts)
}

/// 保存された秘匿値を復号できなかったときの案内
pub const LOCKED_SECRET_MSG: &str = concat!(
    "保存されたパスワードを復号できませんでした。\n",
    "この接続先を開いてパスワードを入力し直してください。\n",
    "(OSのキーチェーンが使えないなどで、暗号化に使う鍵が変わった可能性があります)"
);

/// 読み取り専用の接続では、サーバー側でも書き込みを禁止しておく (二重の防波堤)。
/// SQLiteは接続時に読み取り専用で開いており、Valkeyはコマンド単位で拒否する
async fn apply_read_only(
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
    exec_ctl(conn, qlog, label, db_label, sql).await
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
async fn resolve_dialect(
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

/// SQLiteのプログレスハンドラを呼ぶ間隔 (仮想マシンの命令数)。
/// 小さすぎるとオーバーヘッド、大きすぎると中止の反応が鈍くなる
const SQLITE_PROGRESS_OPS: i32 = 1000;

/// SQLiteの接続に「中止の印」を仕掛け、その印を返す。
///
/// SQLiteはサーバーが無く、別接続から実行中のSQLを止められない。
/// 代わりに、実行しているコネクション自身に一定間隔で印を見てもらい、
/// 立っていたらその場で打ち切ってもらう (SQLITE_INTERRUPT になる)。
/// SQLite以外は None (KILL QUERY / pg_cancel_backend を使う)
async fn install_sqlite_cancel(conn: &mut DbConn) -> Option<Arc<AtomicBool>> {
    let DbConn::Sqlite(c) = conn else {
        return None;
    };
    let flag = Arc::new(AtomicBool::new(false));
    let seen = flag.clone();
    let mut handle = c.lock_handle().await.ok()?;
    // falseを返すとその場で打ち切られる
    handle.set_progress_handler(SQLITE_PROGRESS_OPS, move || {
        !seen.load(Ordering::Relaxed)
    });
    Some(flag)
}

/// 前の操作で立った中止の印を落とす。
///
/// 立てたままにすると、以後のすべての実行が即座に打ち切られる
/// (後始末の ROLLBACK すら通らなくなる)
fn clear_sqlite_cancel(session: &Session) {
    if let Some(f) = session
        .cancel
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&session.id)
        .and_then(|t| t.sqlite_cancel.clone())
    {
        f.store(false, Ordering::Relaxed);
    }
}

/// トランザクションの開始文。
/// SQLiteは読み取りから書き込みへ昇格すると衝突しうる (待てずに SQLITE_BUSY になる) ので、
/// 最初から書き込みで始める
fn begin_sql(conn: &DbConn) -> &'static str {
    if matches!(conn, DbConn::Sqlite(_)) {
        "BEGIN IMMEDIATE"
    } else {
        "BEGIN"
    }
}

/// トランザクションを開始し、開いていることをセッションに覚えさせる。
/// SQLite用に "BEGIN IMMEDIATE" を渡せるよう、開始文は引数で受け取る
async fn begin_txn(
    session: &mut Session,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
    sql: &str,
) -> Result<(), String> {
    // 利用者が開いたトランザクションの上に重ねると、
    // MySQLは暗黙コミット、PostgreSQLは同じトランザクションの続きになる
    if session.txn == TxnState::User {
        return Err(USER_TXN_MSG.to_string());
    }
    /*
     * 状態を先に立てる。
     * BEGIN がサーバーに届いた後で応答を受け取り損ねた場合、
     * 「開いていない」と思い込むほうが危ない
     */
    session.txn = TxnState::Open;
    exec_ctl(&mut session.conn, qlog, label, db_label, sql).await?;
    Ok(())
}

/// トランザクションを閉じる (COMMIT / ROLLBACK)。
///
/// 閉じられなかった場合は接続を Broken として覚えておく。
/// 次の操作の入口 (`ensure_alive`) で接続ごと張り直すので、
/// 開いたままのトランザクションはサーバー側で必ず巻き戻される
async fn end_txn(
    session: &mut Session,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
    commit: bool,
) -> Result<(), String> {
    let sql = if commit { "COMMIT" } else { "ROLLBACK" };
    match exec_ctl(&mut session.conn, qlog, label, db_label, sql).await {
        Ok(()) => {
            session.txn = TxnState::None;
            Ok(())
        }
        // 「トランザクションが無い」と言われたなら、後始末としては目的を果たしている
        // (SQLiteはこれをエラーにする。MySQL・PostgreSQLは成功で返す)
        Err(e) if no_txn_error(&e) => {
            session.txn = TxnState::None;
            Ok(())
        }
        Err(e) => {
            session.txn = TxnState::Broken;
            Err(e)
        }
    }
}

/// 「そもそもトランザクションが開いていない」という応答か
fn no_txn_error(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("no transaction") || m.contains("no active transaction")
}

/// 取り消しを試み、結果に応じた説明を返す (エラーメッセージに添える)
async fn rollback_note(
    session: &mut Session,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
) -> &'static str {
    match end_txn(session, qlog, label, db_label, false).await {
        Ok(()) => "変更はすべて取り消されました。",
        Err(_) => "取り消せなかったため、接続を張り直して取り消します。",
    }
}

/// 「トランザクションで実行」と、SQLに書いたトランザクション制御が重なったときの案内
pub const TXN_MIX_MSG: &str = concat!(
    "「トランザクションで実行」がONのときは、\n",
    "SQLの中に BEGIN / COMMIT / ROLLBACK を書けません。\n",
    "どちらか一方にしてください。"
);

/// 利用者が開いたトランザクションが残っているときの案内
pub const USER_TXN_MSG: &str = concat!(
    "SQLで開いたトランザクションが残っています。\n",
    "COMMIT または ROLLBACK を実行してから、もう一度お試しください。\n",
    "(このまま続けると、開いたままの変更まで一緒に確定してしまいます)"
);

/// 実行中の文が中断された後の、トランザクションの状態。
///
/// SQLiteは書き込みの文を中断するとトランザクションごと巻き戻す
/// (読み取りの文なら巻き戻さない)。
/// こちらが「まだ開いている」と思い込むと、そのタブでは
/// 以後ずっと変更操作を断り続けることになる。
/// MySQL・PostgreSQLは文だけを止めるのでトランザクションは残る
fn txn_after_cancel(db: DbType, txn: TxnState, stmt_read_only: bool) -> TxnState {
    if db == DbType::Sqlite && txn == TxnState::User && !stmt_read_only {
        TxnState::None
    } else {
        txn
    }
}

/// 前の操作がトランザクションを残していた場合に、ログへ出す説明。
/// 後始末が要らないときは None (接続を張り直さない)
fn txn_cleanup_note(txn: TxnState) -> Option<&'static str> {
    match txn {
        // 利用者が自分で開いたトランザクションは正当な状態なので勝手に閉じない
        TxnState::None | TxnState::User => None,
        TxnState::Open => Some("トランザクションが開いたままでした"),
        TxnState::Broken => Some("トランザクションの後始末に失敗していました"),
    }
}

/// 接続を張り直したときに、失われるものを添える説明
const RECONNECT_LOSS: &str = concat!(
    "接続を張り直します ",
    "(未コミットの変更はサーバー側で取り消され、一時テーブル・セッション変数も失われます)"
);

/// 読み取り専用の接続では変更をさせない。
/// 利用者が開いたトランザクションが残っている間も変更させない
/// (Quelioが自前の BEGIN 〜 COMMIT を重ねると、その分まで確定してしまう)
fn ensure_writable(session: &Session) -> Result<(), String> {
    if session.profile.read_only {
        return Err(READ_ONLY_MSG.to_string());
    }
    if session.txn == TxnState::User {
        return Err(USER_TXN_MSG.to_string());
    }
    Ok(())
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

    if profile.read_only {
        apply_read_only(&mut conn, qlog, &label, database.unwrap_or("")).await?;
    }

    // キャンセル用に接続IDを控えておく
    let conn_id = fetch_conn_id(&mut conn).await?;
    // 設定ではなく「実際に暗号化されたか」をサーバーに聞いて記録する。
    // SSH踏み台経由のときは通信路がSSHで守られているので、そうと分かるようにする
    let via_ssh = ep.tunnel.is_some();
    let tls_state = fetch_tls_state(&mut conn).await.map(|s| {
        if via_ssh && s.starts_with("なし") {
            format!("{s} ※SSHトンネル内")
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
    cancel.0.lock().unwrap().insert(
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
        if let Some(t) = session.cancel.0.lock().unwrap().get_mut(&session.id) {
            t.conn_id = conn_id;
            t.host = session.host.clone();
            t.port = session.port;
            t.sqlite_cancel = sqlite_cancel;
        }
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
async fn ensure_alive(session: &mut Session, qlog: &QueryLog) -> Result<(), String> {
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

    /*
     * 中止用の接続を張っている間に、相手が終わって接続を閉じていることがある。
     * 接続IDはサーバー側で使い回されるので、そのまま送ると
     * 無関係な接続を止めてしまう。送る直前にもう一度確かめる
     */
    let still_running = || {
        cancel
            .0
            .lock()
            .unwrap()
            .get(session_id)
            .is_some_and(|t| t.conn_id == target.conn_id)
    };

    match target.db_type {
        DbType::Mysql => {
            let mut c = db::connect_mysql(
                &target.host,
                target.port,
                &target.user,
                &target.password,
                None,
                &target.db_tls,
            )
            .await?;
            if !still_running() {
                let _ = timeout(CLOSE_TIMEOUT, c.close()).await;
                return Ok(());
            }
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
                &target.db_tls,
            )
            .await?;
            if !still_running() {
                let _ = timeout(CLOSE_TIMEOUT, c.close()).await;
                return Ok(());
            }
            let sql = format!("SELECT pg_cancel_backend({})", target.conn_id);
            qlog.add(&target.label, "", &sql);
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
                .execute(&mut c)
                .await
                .map_err(db::format_db_error)?;
            let _ = timeout(CLOSE_TIMEOUT, c.close()).await;
        }
        DbType::Sqlite => {
            /*
             * SQLiteには止めに行く相手 (サーバー) がいないので、
             * 実行しているコネクション自身に見てもらう印を立てる。
             * 印は次の操作の入口 (ensure_alive) で落とす
             */
            let Some(flag) = target.sqlite_cancel.clone() else {
                return Err("この接続では実行中の処理を中止できません".into());
            };
            if !still_running() {
                return Ok(());
            }
            qlog.add(&target.label, "", "-- 実行中の処理に中止を要求");
            flag.store(true, Ordering::Relaxed);
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
/// SQLエディタの補完に使う「テーブル名 → カラム名」の一覧を返す
pub async fn schema_columns(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<catalog::SchemaColumns, String> {
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
        DbConn::MySql(conn) => {
            catalog::mysql_schema_columns(conn, database, &ctx).await
        }
        DbConn::Pg(_) => {
            ensure_pg_database(session, database, qlog).await?;
            match &mut session.conn {
                DbConn::Pg(conn) => catalog::pg_schema_columns(conn, &ctx).await,
                _ => unreachable!(),
            }
        }
        DbConn::Sqlite(conn) => catalog::sqlite_schema_columns(conn, &ctx).await,
        DbConn::Kv(_) => Ok(Vec::new()),
    }
}

/// カラムに使える型の一覧を返す。
/// MySQL / SQLiteは仕様で決まっているので固定の一覧、
/// PostgreSQLはユーザー定義型もあるのでDBから取得する
pub async fn list_column_types(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<Vec<String>, String> {
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
        DbConn::MySql(_) => Ok(crate::ddl::MYSQL_TYPES
            .iter()
            .map(|s| s.to_string())
            .collect()),
        DbConn::Pg(conn) => {
            // よく使う型を先頭に、DBから取れた型、最後に別名 (int4など) を足す
            let mut out: Vec<String> = crate::ddl::PG_COMMON_TYPES
                .iter()
                .map(|s| s.to_string())
                .collect();
            let push = |out: &mut Vec<String>, t: String| {
                if !out.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
                    out.push(t);
                }
            };
            for t in catalog::pg_types(conn, &ctx).await? {
                push(&mut out, t);
            }
            for a in crate::ddl::PG_TYPE_ALIASES {
                push(&mut out, a.to_string());
            }
            Ok(out)
        }
        DbConn::Sqlite(_) => Ok(crate::ddl::SQLITE_TYPES
            .iter()
            .map(|s| s.to_string())
            .collect()),
        DbConn::Kv(_) => Ok(Vec::new()),
    }
}

/// 使える照合順序の一覧を返す (MySQL / PostgreSQLのみ。他は空)
pub async fn list_collations(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<Vec<String>, String> {
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
        DbConn::MySql(conn) => catalog::mysql_collations(conn, &ctx).await,
        DbConn::Pg(conn) => catalog::pg_collations(conn, &ctx).await,
        // SQLiteの照合順序は型定義の一部で、後から変えられない
        DbConn::Sqlite(_) | DbConn::Kv(_) => Ok(Vec::new()),
    }
}

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

/// ER図用: スキーマと外部キーを1本の接続でまとめて取る。
///
/// 別々のコマンドにすると収集用の接続 (とSSHトンネル) が2本になるため、
/// 1回の呼び出しで両方を返す
pub async fn schema_with_foreign_keys(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<(Vec<SchemaEntry>, Vec<crate::models::FkInfo>), String> {
    if let Some(mut sc) = open_schema_conn(sessions, qlog, session_id, database).await? {
        let label = sc.label.clone();
        let result = async {
            let entries = collect_schema_conn(sc.conn(), qlog, &label, database).await?;
            let fks = foreign_keys_conn(sc.conn(), qlog, &label, database).await?;
            Ok((entries, fks))
        }
        .await;
        sc.close().await;
        return result;
    }
    // SQLite / Valkey はタブの接続で集める
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    // PostgreSQLは対象のDBにつながっていないとカタログが見えない
    if matches!(session.conn, DbConn::Pg(_)) {
        ensure_pg_database(session, database, qlog).await?;
    }
    let label = conn_label(&session.profile);
    let entries = collect_schema_conn(&mut session.conn, qlog, &label, database).await?;
    let fks = foreign_keys_conn(&mut session.conn, qlog, &label, database).await?;
    Ok((entries, fks))
}

/// 外部キーの取得 (接続だけを受け取る)。
/// PostgreSQLは「対象のDBにつながっている接続」を渡すこと
async fn foreign_keys_conn(
    conn: &mut DbConn,
    qlog: &QueryLog,
    label: &str,
    database: &str,
) -> Result<Vec<crate::models::FkInfo>, String> {
    let ctx = LogCtx {
        qlog,
        connection: label,
        database,
    };
    match conn {
        DbConn::MySql(c) => catalog::mysql_foreign_keys(c, database, &ctx).await,
        DbConn::Pg(c) => catalog::pg_foreign_keys(c, &ctx).await,
        DbConn::Sqlite(c) => catalog::sqlite_foreign_keys(c, &ctx).await,
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
    // ここから先は接続を握っている。サーバーへ中止を送っても、無関係なSQLを止めることはない
    if let Some(j) = job {
        j.mark_running();
    }
    if matches!(session.conn, DbConn::Kv(_)) {
        return Err("Valkey接続ではSQLは実行できません".into());
    }
    // 空のSQLでは接続の切り替え (PostgreSQLは張り直し) をせずに断る
    if sql.trim().is_empty() {
        return Err("実行するSQLがありません".into());
    }
    let label = conn_label(&session.profile);
    let db_label = database.clone().unwrap_or_default();
    ensure_database(session, database.as_ref(), qlog, &label).await?;
    // 読み取り専用の接続では、CSV出力の名目でも変更系SQLは実行しない
    // (接続先が定まってから、その接続の方言で分割して確かめる)
    let stmts = split_checked(session, sql)?;
    if stmts.is_empty() {
        return Err("実行するSQLがありません".into());
    }
    // 複数文をまとめて渡されると、どの結果をCSVにするか決められない
    if stmts.len() > 1 {
        return Err("CSV出力は1つのSQLずつ行ってください".into());
    }

    /*
     * CSV出力でも `SET …` は実行できるので、方言が変わったら聞き直す。
     * 聞き直しは実行の後 (成功・失敗どちらでも) に行う
     */
    let mut dialect_dirty = stmts
        .iter()
        .any(|st| query::changes_dialect(session.dialect, st));

    let mysql_quoting = matches!(session.conn, DbConn::MySql(_));
    let out_sql = query::plan_export(sql, order, mysql_quoting);
    qlog.add(&label, &db_label, &out_sql);

    let file = std::fs::File::create(path).map_err(|e| format!("CSVを作成できません: {e}"))?;
    let mut out = std::io::BufWriter::new(file);
    // 読み取り専用の接続はプリペアドで送り、複数文をサーバー側でも弾く
    let mode = query::SqlMode::for_read_only(
        session.profile.read_only,
        session.txn != TxnState::None,
    );
    let res = match &mut session.conn {
        DbConn::MySql(conn) => query::export_csv_mysql(conn, &out_sql, mode, &mut out, job).await,
        DbConn::Pg(conn) => query::export_csv_pg(conn, &out_sql, mode, &mut out, job).await,
        DbConn::Sqlite(conn) => {
            query::export_csv_sqlite(conn, &out_sql, mode, &mut out, job).await
        }
        DbConn::Kv(_) => unreachable!(),
    };
    refresh_dialect(session, qlog, &label, &db_label, &mut dialect_dirty).await;
    let (rows, cancelled) = res?;
    std::io::Write::flush(&mut out).map_err(|e| format!("CSVを書き込めません: {e}"))?;
    Ok((rows, cancelled))
}

/// セッションのDB種別を返す (DDLの方言を決めるのに使う)
pub async fn session_db_type(
    sessions: &Sessions,
    session_id: &str,
) -> Result<DbType, String> {
    let arc = get_session(sessions, session_id).await?;
    let guard = arc.lock().await;
    Ok(guard.profile.db_type)
}

/// DDL (カラム変更など) を順に実行する。
/// PostgreSQL / SQLite はDDLもトランザクションに入れられるため、
/// 途中で失敗したときに中途半端な状態が残らないよう BEGIN〜COMMIT で包む
pub async fn exec_ddl(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: Option<String>,
    statements: &[String],
) -> Result<(), String> {
    if statements.is_empty() {
        return Err("実行するSQLがありません".into());
    }
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_writable(session)?;
    ensure_alive(session, qlog).await?;
    if matches!(session.conn, DbConn::Kv(_)) {
        return Err("Valkey接続では実行できません".into());
    }
    let label = conn_label(&session.profile);
    let db_label = database.clone().unwrap_or_default();
    ensure_database(session, database.as_ref(), qlog, &label).await?;

    // MySQLはDDLで暗黙コミットされるためトランザクションで包まない
    let use_txn = !matches!(session.conn, DbConn::MySql(_)) && statements.len() > 1;
    if use_txn {
        let begin = begin_sql(&session.conn);
        begin_txn(session, qlog, &label, &db_label, begin).await?;
    }
    for sql in statements {
        if let Err(e) = exec_ctl(&mut session.conn, qlog, &label, &db_label, sql).await {
            if use_txn {
                let note = rollback_note(session, qlog, &label, &db_label).await;
                return Err(format!("{e}\n{note}"));
            }
            return Err(e);
        }
    }
    if use_txn {
        end_txn(session, qlog, &label, &db_label, true).await?;
    }
    Ok(())
}

/// 接続しているサーバーのデータベース一覧を取り直してセッションに覚えさせる
async fn refresh_databases(
    session: &mut Session,
    qlog: &QueryLog,
    label: &str,
) -> Result<Vec<String>, String> {
    let db_label = session.current_db.clone().unwrap_or_default();
    let ctx = LogCtx {
        qlog,
        connection: label,
        database: &db_label,
    };
    let list = match &mut session.conn {
        DbConn::MySql(c) => catalog::mysql_databases(c, &ctx).await?,
        DbConn::Pg(c) => catalog::pg_databases(c, &ctx).await?,
        _ => return Err("この接続では扱えません".into()),
    };
    session.databases = list.clone();
    Ok(list)
}

/// MySQLが今どのデータベースを使っているかをサーバーに聞く。
///
/// ユーザーがSQLエディタで `USE` を打つと接続の既定が変わるので、
/// 覚えている値 (`current_db`) だけを信じない
async fn mysql_current_db(conn: &mut DbConn) -> Option<String> {
    let DbConn::MySql(c) = conn else { return None };
    sqlx::query_scalar::<_, Option<String>>("SELECT DATABASE()")
        .fetch_one(&mut *c)
        .await
        .ok()
        .flatten()
}

/// データベースの作成・削除に共通の下ごしらえ (書き込み可・生存・種類の確認)
async fn begin_db_admin(
    session: &mut Session,
    qlog: &QueryLog,
) -> Result<(DbType, String), String> {
    ensure_writable(session)?;
    ensure_alive(session, qlog).await?;
    match session.conn {
        DbConn::Sqlite(_) => {
            return Err("SQLiteはファイル1つが1データベースです".into())
        }
        DbConn::Kv(_) => return Err("Valkey接続ではこの操作はできません".into()),
        _ => {}
    }
    Ok((session.profile.db_type, conn_label(&session.profile)))
}

/// データベースを作る (作成後の一覧を返す)
pub async fn create_database(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    name: &str,
    encoding: Option<String>,
    collation: Option<String>,
) -> Result<Vec<String>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    let (db_type, label) = begin_db_admin(session, qlog).await?;
    let sql = crate::dbadmin::create_database_sql(
        db_type,
        name,
        encoding.as_deref(),
        collation.as_deref(),
    )?;
    let db_label = session.current_db.clone().unwrap_or_default();
    exec_ctl(&mut session.conn, qlog, &label, &db_label, &sql).await?;
    refresh_databases(session, qlog, &label).await
}

/// データベースを消す (削除後の一覧を返す)
pub async fn drop_database(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    name: &str,
) -> Result<Vec<String>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    let (db_type, label) = begin_db_admin(session, qlog).await?;
    /*
     * 今つないでいるデータベースは消せない。
     * PostgreSQLはサーバーが断り、MySQLは消せてしまうが
     * 行き先の無い接続が残ってしまう
     */
    let mut current = session.current_db.clone();
    if db_type == DbType::Mysql {
        // 覚えている値がずれていることがあるので、サーバーにも聞く
        if let Some(actual) = mysql_current_db(&mut session.conn).await {
            session.current_db = Some(actual.clone());
            current = Some(actual);
        }
    }
    // MySQLはDB名の大小を区別しない設定があるので、大小を無視して見る
    if current
        .as_deref()
        .is_some_and(|c| c.eq_ignore_ascii_case(name))
    {
        return Err(
            "今つないでいるデータベースは削除できません (別のデータベースに切り替えてから実行してください)"
                .into(),
        );
    }
    let sql = crate::dbadmin::drop_database_sql(db_type, name)?;
    let db_label = session.current_db.clone().unwrap_or_default();
    exec_ctl(&mut session.conn, qlog, &label, &db_label, &sql).await?;
    refresh_databases(session, qlog, &label).await
}

/// 文字コード (エンコーディング) と照合順序の一覧。
///
/// データベースを作るときに画面で選べるようにするために使う
pub async fn list_charsets(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
) -> Result<Vec<catalog::CharsetInfo>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    let label = conn_label(&session.profile);
    let db_label = session.current_db.clone().unwrap_or_default();
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database: &db_label,
    };
    match &mut session.conn {
        DbConn::MySql(c) => catalog::mysql_charsets(c, &ctx).await,
        DbConn::Pg(c) => catalog::pg_encodings(c, &ctx).await,
        // SQLite・Valkeyにはデータベースを作る操作が無い
        _ => Ok(Vec::new()),
    }
}

/// スキーマの一覧 (PostgreSQLのみ)
pub async fn list_schemas(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<Vec<String>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    /*
     * ensure_database はMySQLとSQLite以外をPostgreSQLとみなして接続を張り直す。
     * Valkeyを渡してしまわないよう、先に種類を確かめる
     */
    if !matches!(session.conn, DbConn::Pg(_)) {
        return Err("スキーマを扱えるのはPostgreSQLだけです".into());
    }
    let label = conn_label(&session.profile);
    ensure_database(session, Some(&database.to_string()), qlog, &label).await?;
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database,
    };
    match &mut session.conn {
        DbConn::Pg(c) => catalog::pg_schemas(c, &ctx).await,
        _ => Err("スキーマを扱えるのはPostgreSQLだけです".into()),
    }
}

/// スキーマを作る / 消す (処理後の一覧を返す)
pub async fn change_schema(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    name: &str,
    // drop: trueなら削除、falseなら作成
    drop: bool,
    // cascade: 削除時に中身ごと消すか
    cascade: bool,
) -> Result<Vec<String>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    let (db_type, label) = begin_db_admin(session, qlog).await?;
    if drop && crate::dbadmin::is_system_schema(name) {
        return Err("システムのスキーマは削除できません".into());
    }
    let sql = if drop {
        crate::dbadmin::drop_schema_sql(db_type, name, cascade)?
    } else {
        crate::dbadmin::create_schema_sql(db_type, name)?
    };
    ensure_database(session, Some(&database.to_string()), qlog, &label).await?;
    exec_ctl(&mut session.conn, qlog, &label, database, &sql).await?;
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database,
    };
    match &mut session.conn {
        DbConn::Pg(c) => catalog::pg_schemas(c, &ctx).await,
        _ => Err("スキーマを扱えるのはPostgreSQLだけです".into()),
    }
}

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
    match conn {
        DbConn::MySql(c) => {
            let mut q = sqlx::query(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            q.execute(&mut *c)
                .await
                .map(|r| r.rows_affected())
                .map_err(db::format_db_error)
        }
        DbConn::Pg(c) => {
            let mut q = sqlx::query(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            q.execute(&mut *c)
                .await
                .map(|r| r.rows_affected())
                .map_err(db::format_db_error)
        }
        DbConn::Sqlite(c) => {
            let mut q = sqlx::query(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            q.execute(&mut *c)
                .await
                .map(|r| r.rows_affected())
                .map_err(db::format_db_error)
        }
        DbConn::Kv(_) => Err("Valkey接続では使用できません".into()),
    }
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
    .map_err(|_| "セルの取得がタイムアウトしました".to_string())?
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
    .map_err(|_| "件数の取得がタイムアウトしました".to_string())?
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
    match conn {
        DbConn::MySql(c) => {
            let mut q = sqlx::query_scalar::<_, i64>(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            q.fetch_one(&mut *c).await.map_err(db::format_db_error)
        }
        DbConn::Pg(c) => {
            let mut q = sqlx::query_scalar::<_, i64>(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            q.fetch_one(&mut *c).await.map_err(db::format_db_error)
        }
        DbConn::Sqlite(c) => {
            let mut q = sqlx::query_scalar::<_, i64>(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            q.fetch_one(&mut *c).await.map_err(db::format_db_error)
        }
        DbConn::Kv(_) => Err("Valkey接続では使用できません".into()),
    }
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
    params: &std::collections::HashMap<String, query::ParamValue>,
) -> Result<RunOutput, String> {
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
    // 空のSQLでは接続の切り替え (PostgreSQLは張り直し) をせずに断る
    if sql.trim().is_empty() {
        return Err("実行するSQLがありません".into());
    }
    let label = conn_label(&session.profile);
    let db_label = database.clone().unwrap_or_default();

    ensure_database(session, database.as_ref(), qlog, &label).await?;

    // 文の区切りは接続先の設定によって違う (PostgreSQLの $$ … $$ や
    // MySQLの NO_BACKSLASH_ESCAPES など) ので、接続が定まってから分割する。
    // 読み取り専用の接続なら、ここでデータが変わるSQLも弾かれる
    let stmts = split_checked(session, sql)?;
    if stmts.is_empty() {
        return Err("実行するSQLがありません".into());
    }
    let single = stmts.len() == 1;

    // EXPLAIN ANALYZE は対象のSQLを実際に実行して計測するため、
    // データが変わる可能性のあるSQLは受け付けない (SQLiteはEXPLAIN QUERY PLANなので対象外)
    if explain.as_deref() == Some("analyze") && !matches!(session.conn, DbConn::Sqlite(_)) {
        let d = session.dialect;
        if let Some(bad) = stmts.iter().find(|s| !query::is_analyzable(d, s)) {
            let head: String = bad.chars().take(60).collect();
            return Err(format!(
                concat!(
                    "実行計画 (ANALYZE) は対象のSQLを実際に実行して計測するため、\n",
                    "SELECT などの参照系SQLでのみ使えます。\n",
                    "それ以外は EXPLAIN (実行計画のみ) をお使いください。\n\n",
                    "対象: {head}"
                ),
                head = head
            ));
        }
    }

    // トランザクション実行: 全文成功でCOMMIT、途中エラーでROLLBACK
    let db_type = session.profile.db_type;
    let dialect = session.dialect;
    let effects: Vec<Option<bool>> = stmts
        .iter()
        .map(|s| query::txn_effect(db_type, dialect, s))
        .collect();
    if transaction && effects.iter().any(|e| e.is_some()) {
        // Quelio側の BEGIN 〜 COMMIT と二重になり、どこまでが取り消せるのか決まらない
        return Err(TXN_MIX_MSG.to_string());
    }
    // 入れ子の BEGIN はDBによって黙って別の意味になる
    if session.txn == TxnState::User && effects.contains(&Some(true)) {
        return Err(USER_TXN_MSG.to_string());
    }

    if transaction {
        let begin = begin_sql(&session.conn);
        begin_txn(session, qlog, &label, &db_label, begin).await?;
    }

    let mysql_quoting = matches!(session.conn, DbConn::MySql(_));
    /*
     * SET などで設定を変えられると、接続時に聞いた方言が古くなる。
     * 実行した後に聞き直すため、対象の文があったかを覚えておく
     * (トランザクションの中の SET は取り消しでも戻るので、最後にまとめて聞く)
     */
    let mut dialect_dirty = stmts.iter().any(|s| query::changes_dialect(dialect, s));
    /*
     * 読み取り専用の接続はプリペアドで送り、複数文をサーバー側でも弾く。
     * トランザクションで実行するときは、途中でやり直すと
     * PostgreSQLが中断状態になるので、やり直しはしない
     */
    let mode = query::SqlMode::for_read_only(
        session.profile.read_only,
        transaction || session.txn != TxnState::None,
    );
    /*
     * ここまでの判定 (文の分割・読み取り専用・実行計画の可否・
     * トランザクション制御・方言の変化) は、すべてプレースホルダのまま済ませた。
     * 値を入れるのはここが最初なので、値が「何が実行されるか」を左右できない
     */
    let filled: Vec<String> = stmts
        .iter()
        .map(|s| query::substitute_params(dialect, s, params))
        .collect();

    let mut statements: Vec<StatementResult> = Vec::new();
    for (i, stmt) in stmts.iter().enumerate() {
        // 実際にサーバーへ送る形 (値を入れたもの)
        let run_sql = &filled[i];
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
                sql: format!("{prefix}{run_sql}"),
                is_fetch: true,
                pageable: false,
                offset: 0,
                order_by: None,
                order_dir: None,
                // 実行計画は途中で切れると読めないので、切り詰めずに全部返す
                full: true,
            }
        } else {
            query::plan(
                run_sql,
                if single { offset } else { 0 },
                if single { order } else { None },
                mysql_quoting,
            )
        };
        qlog.add(&label, &db_label, &plan.sql);

        /*
         * トランザクションを開く文は、実行する「前」に覚える。
         * サーバーに届いた後で応答を受け取り損ねた場合、
         * 「開いていない」と思い込むほうが危ない
         */
        if effects[i] == Some(true) {
            session.txn = TxnState::User;
        }

        let res = match &mut session.conn {
            DbConn::MySql(conn) => query::run_mysql(conn, &plan, mode, timeout_secs).await,
            DbConn::Pg(conn) => query::run_pg(conn, &plan, mode, timeout_secs).await,
            DbConn::Sqlite(conn) => query::run_sqlite(conn, &plan, mode, timeout_secs).await,
            DbConn::Kv(_) => unreachable!(),
        };

        match res {
            Ok(r) => {
                // 閉じる文は、通ったことを確かめてから落とす
                if effects[i] == Some(false) {
                    session.txn = TxnState::None;
                }
                statements.push(StatementResult {
                    sql: run_sql.clone(),
                    result: r,
                });
            }
            Err(e) => {
                // 中断された文の後で、覚えている状態が実際とずれていないか合わせる
                if e == db::CANCELLED_MSG {
                    session.txn = txn_after_cancel(
                        db_type,
                        session.txn,
                        query::is_read_only(dialect, stmt),
                    );
                }
                // タイムアウトは応答の途中で打ち切るため、接続の状態がずれうる。
                // 次の操作で必ず生存確認 (ping) が走るようにしておく
                if e.starts_with("クエリがタイムアウトしました") {
                    session.last_used = std::time::Instant::now()
                        .checked_sub(IDLE_PING_AFTER)
                        .unwrap_or_else(std::time::Instant::now);
                }
                let mut msg = if single {
                    e
                } else {
                    format!("{}文目でエラー: {e}", i + 1)
                };
                if transaction {
                    match end_txn(session, qlog, &label, &db_label, false).await {
                        Ok(()) => {
                            msg = format!("{msg}\nロールバックしました (変更はすべて取り消されました)");
                        }
                        Err(re) => {
                            msg = format!("{msg}\nロールバックにも失敗しました: {re}");
                        }
                    }
                }
                refresh_dialect(session, qlog, &label, &db_label, &mut dialect_dirty).await;
                return Ok(RunOutput {
                    statements,
                    error: Some(msg),
                    failed_index: Some(i),
                });
            }
        }
    }

    if transaction {
        // 失敗しても、設定を触った後なら方言は聞き直しておく
        let committed = end_txn(session, qlog, &label, &db_label, true).await;
        refresh_dialect(session, qlog, &label, &db_label, &mut dialect_dirty).await;
        committed?;
    }
    refresh_dialect(session, qlog, &label, &db_label, &mut dialect_dirty).await;

    Ok(RunOutput {
        statements,
        error: None,
        failed_index: None,
    })
}

/// 設定を触る文が実行された後に、実際の方言を聞き直す。
/// 毎回聞くと1往復ぶん遅くなるので、対象があったときだけ
async fn refresh_dialect(
    session: &mut Session,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
    dirty: &mut bool,
) {
    if !*dirty {
        return;
    }
    *dirty = false;
    /*
     * 直前の文がタイムアウトで打ち切られていると、
     * 残りの応答を読み切るまで返ってこないことがある。
     * セッションのロックを握ったままなので上限を置く
     * (聞けなければ、安全側 = 文を多めに割る方言のままになる)
     */
    match timeout(
        DIALECT_TIMEOUT,
        resolve_dialect(
            session.profile.db_type,
            &mut session.conn,
            qlog,
            label,
            db_label,
        ),
    )
    .await
    {
        Ok(d) => session.dialect = d,
        Err(_) => qlog.add(
            label,
            db_label,
            "-- 方言の確認が時間内に終わりませんでした。前の設定のまま読みます",
        ),
    }
}

/// 指定DBの全テーブルのスキーマ情報 (テーブル+カラム+インデックス) を収集する
async fn collect_schema_local(
    session: &mut Session,
    qlog: &QueryLog,
    database: &str,
) -> Result<Vec<SchemaEntry>, String> {
    // PostgreSQLは対象のDBにつながっていないとカタログが見えない
    if matches!(session.conn, DbConn::Pg(_)) {
        ensure_pg_database(session, database, qlog).await?;
    }
    let label = conn_label(&session.profile);
    collect_schema_conn(&mut session.conn, qlog, &label, database).await
}

/// スキーマ収集の本体 (接続だけを受け取る)。
///
/// PostgreSQLは「対象のDBにつながっている接続」を渡すこと
async fn collect_schema_conn(
    conn: &mut DbConn,
    qlog: &QueryLog,
    label: &str,
    database: &str,
) -> Result<Vec<SchemaEntry>, String> {
    let ctx = LogCtx {
        qlog,
        connection: label,
        database,
    };

    // テーブル一覧
    let tables = match conn {
        DbConn::MySql(c) => catalog::mysql_tables(c, database, &ctx).await?,
        DbConn::Pg(c) => catalog::pg_tables(c, &ctx).await?,
        DbConn::Sqlite(c) => catalog::sqlite_tables(c, &ctx).await?,
        DbConn::Kv(_) => return Err("Valkey接続では使用できません".into()),
    };

    // テーブルごとの詳細。
    // 1テーブルずつ問い合わせるとテーブル数×3回の往復になるため、
    // MySQL / PostgreSQL はスキーマ全体を数クエリで取ってから振り分ける
    let mut items = Vec::with_capacity(tables.len());
    match conn {
        DbConn::MySql(conn) => {
            let mut all = catalog::mysql_schema_details(conn, database, &ctx).await?;
            for t in &tables {
                items.push(SchemaEntry {
                    table: t.clone(),
                    detail: all.remove(&t.name).unwrap_or_default(),
                });
            }
        }
        DbConn::Pg(conn) => {
            let mut all = catalog::pg_schema_details(conn, &ctx).await?;
            for t in &tables {
                let schema = t.schema.clone().unwrap_or_else(|| "public".to_string());
                items.push(SchemaEntry {
                    table: t.clone(),
                    detail: all.remove(&(schema, t.name.clone())).unwrap_or_default(),
                });
            }
        }
        DbConn::Sqlite(conn) => {
            // SQLiteはローカルファイルなので、1テーブルずつでも十分速い
            for t in &tables {
                let detail = catalog::sqlite_table_detail(conn, &t.name, &ctx).await?;
                items.push(SchemaEntry {
                    table: t.clone(),
                    detail,
                });
            }
        }
        DbConn::Kv(_) => return Err("Valkey接続では使用できません".into()),
    }
    Ok(items)
}

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
                            crate::csv_import::MAX_ROWS
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
fn mark_rolling_back(job: Option<&crate::csv_job::CsvJob>) {
    if let Some(j) = job {
        j.set_phase(crate::csv_job::JobPhase::RollingBack);
    }
}

/// 値を渡してSQLを実行する (ログに出さない版。CSV取り込みのように何度も呼ぶ用)
async fn exec_bound_quiet(
    conn: &mut DbConn,
    sql: &str,
    params: &[Option<String>],
) -> Result<u64, String> {
    // SQLは自前で組み立てた固定の形 (値はすべてプレースホルダ) なので安全
    let safe = sqlx::AssertSqlSafe(sql.to_string());
    match conn {
        DbConn::MySql(c) => {
            let mut q = sqlx::query(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            q.execute(&mut *c)
                .await
                .map(|r| r.rows_affected())
                .map_err(db::format_db_error)
        }
        DbConn::Pg(c) => {
            let mut q = sqlx::query(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            q.execute(&mut *c)
                .await
                .map(|r| r.rows_affected())
                .map_err(db::format_db_error)
        }
        DbConn::Sqlite(c) => {
            let mut q = sqlx::query(safe);
            for p in params {
                q = q.bind(p.clone());
            }
            q.execute(&mut *c)
                .await
                .map(|r| r.rows_affected())
                .map_err(db::format_db_error)
        }
        DbConn::Kv(_) => Err("Valkey接続ではSQLは実行できません".into()),
    }
}

/// サーバー側で動いている接続の一覧を返す (読むだけ)
pub async fn list_processes(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    log: bool,
) -> Result<Vec<catalog::ProcessInfo>, String> {
    let arc = get_session(sessions, session_id).await?;
    /*
     * この画面は数秒ごとに取り直す。
     * ロック待ちにすると、自分のタブで長いSQLを実行している間に
     * 問い合わせが積み上がってしまうので、待たずに諦める
     */
    let Ok(mut guard) = arc.try_lock() else {
        return Err(
            "このタブでSQLを実行中のため取得できません (終わるまでお待ちください)".into(),
        );
    };
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    let label = conn_label(&session.profile);
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database,
    };
    match &mut session.conn {
        DbConn::MySql(conn) => catalog::mysql_processes(conn, &ctx, log).await,
        DbConn::Pg(conn) => catalog::pg_processes(conn, &ctx, log).await,
        DbConn::Sqlite(_) => {
            Err("SQLiteはファイルを直接開くため、接続の一覧はありません".into())
        }
        DbConn::Kv(_) => Err("Valkey接続では使用できません".into()),
    }
}

/// 実行中クエリへの操作
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessAction {
    /// 実行中のSQLだけ止める (接続は残る)
    Cancel,
    /// 接続ごと切る
    Terminate,
}

/// 他の接続のSQLを中止する / 接続を切る。
///
/// 読み取り専用の接続では行わない
/// (サーバーの状態を変えない、という約束を守るため)
pub async fn kill_process(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    target: i64,
    action: ProcessAction,
) -> Result<(), String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    if session.profile.read_only {
        return Err(READ_ONLY_MSG.to_string());
    }
    // 自分自身の接続は切らせない (画面側でも出さないが、ここでも止める)
    let me = session.cancel.0.lock().unwrap().get(&session.id).map(|t| t.conn_id);
    if me == Some(target) {
        return Err(
            "この画面自身の接続です。実行中のSQLは「キャンセル」ボタンで止められます".into(),
        );
    }
    ensure_alive(session, qlog).await?;
    let label = conn_label(&session.profile);
    let sql = match (&session.conn, action) {
        (DbConn::MySql(_), ProcessAction::Cancel) => format!("KILL QUERY {target}"),
        (DbConn::MySql(_), ProcessAction::Terminate) => format!("KILL {target}"),
        (DbConn::Pg(_), ProcessAction::Cancel) => {
            format!("SELECT pg_cancel_backend({target})")
        }
        (DbConn::Pg(_), ProcessAction::Terminate) => {
            format!("SELECT pg_terminate_backend({target})")
        }
        _ => return Err("この接続では使用できません".into()),
    };
    qlog.add(&label, database, &sql);
    match &mut session.conn {
        // MySQLは相手が居なければエラー (ERROR 1094) になる
        DbConn::MySql(conn) => sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(&mut *conn)
            .await
            .map(|_| ())
            .map_err(db::format_db_error),
        /*
         * PostgreSQLは相手が居なくてもエラーにならず false を返すだけ。
         * 「送りました」と出して何も起きない、を避けるため戻り値を見る
         */
        DbConn::Pg(conn) => {
            let ok: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                .fetch_one(&mut *conn)
                .await
                .map_err(db::format_db_error)?;
            if ok {
                Ok(())
            } else {
                Err("対象の接続が見つかりませんでした (既に終了した可能性があります)".into())
            }
        }
        _ => Err("この接続では使用できません".into()),
    }
}

/// 関数・プロシージャ・トリガの定義を返す (読むだけ)
pub async fn list_routines(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<Vec<catalog::RoutineInfo>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    let label = conn_label(&session.profile);
    ensure_database(session, Some(&database.to_string()), qlog, &label).await?;
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database,
    };
    match &mut session.conn {
        DbConn::MySql(conn) => catalog::mysql_routines(conn, database, &ctx).await,
        DbConn::Pg(conn) => catalog::pg_routines(conn, &ctx).await,
        DbConn::Sqlite(conn) => catalog::sqlite_routines(conn, &ctx).await,
        DbConn::Kv(_) => Err("Valkey接続では使用できません".into()),
    }
}

/// テーブルの CREATE 文を返す (定義の共有・コピー用)
pub async fn table_ddl(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: Option<String>,
    schema: Option<String>,
    table: &str,
) -> Result<String, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    let label = conn_label(&session.profile);
    let db_label = database.clone().unwrap_or_default();
    ensure_database(session, database.as_ref(), qlog, &label).await?;
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database: &db_label,
    };
    match &mut session.conn {
        DbConn::MySql(conn) => {
            catalog::mysql_table_ddl(conn, &db_label, table, &ctx).await
        }
        DbConn::Pg(conn) => {
            let schema = schema.unwrap_or_else(|| "public".to_string());
            catalog::pg_table_ddl(conn, &schema, table, &ctx).await
        }
        DbConn::Sqlite(conn) => catalog::sqlite_table_ddl(conn, table, &ctx).await,
        DbConn::Kv(_) => Err("Valkey接続では使用できません".into()),
    }
}

/// スキーマ収集の鍵に付ける通し番号 (同じタブで同時に走っても区別できるように)
static SCHEMA_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// スキーマ収集用の接続をキャンセル対象として登録するときの鍵。
/// タブ本体のSQL実行 (鍵はセッションID) と混ざらないよう区切り文字を挟む
fn schema_cancel_key(session_id: &str) -> String {
    let n = SCHEMA_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{}{n}", schema_cancel_prefix(session_id))
}

fn schema_cancel_prefix(session_id: &str) -> String {
    format!("{session_id}\u{0}schema\u{0}")
}

/// スキーマ収集中の接続を中止する。
/// 同じタブで複数走っていることがあるので、そのタブのぶんを全て止める
pub async fn cancel_schema_load(
    cancel: &CancelRegistry,
    qlog: &QueryLog,
    session_id: &str,
) -> Result<(), String> {
    let prefix = schema_cancel_prefix(session_id);
    let keys: Vec<String> = {
        let map = cancel.0.lock().unwrap();
        map.keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect()
    };
    let mut last_err = None;
    for k in keys {
        // 押した直後に終わっていることがあるので、消えていたら成功扱いにする
        if !cancel.0.lock().unwrap().contains_key(&k) {
            continue;
        }
        if let Err(e) = cancel_query(cancel, qlog, &k).await {
            last_err = Some(e);
        }
    }
    match last_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/*
 * スキーマ収集は、テーブル数が多いDBだと分単位で掛かる。
 * タブの接続をそのまま使うとその間タブが操作できなくなるため、
 * MySQL / PostgreSQL は同じ接続先へ「もう1本だけ」つないで、そちらで集める。
 *
 * SQLiteはローカルファイルなのでタブの接続をそのまま使う
 * (別ハンドルを開いても速くならず、書き込みロックの取り合いになるだけ)。
 */

/// スキーマ収集専用の接続。
///
/// 「中止」できるようキャンセル用レジストリに登録し、
/// 途中で落ちても (パニックしても) Drop で必ず登録を消す
struct SchemaConn {
    conn: Option<DbConn>,
    /// コンソールに出す接続名 (タブの接続と見分けられるようにする)
    label: String,
    cancel: CancelRegistry,
    key: String,
    /// 自前で張ったSSHトンネル。
    /// セッション側の張り直しに巻き込まれないよう、収集用は別に張る
    tunnel: Option<SshTunnel>,
}

impl SchemaConn {
    fn conn(&mut self) -> &mut DbConn {
        // close() は self を消費するので、閉じた後にここへ来ることはない
        self.conn.as_mut().expect("接続は閉じられています")
    }

    fn unregister(&self) {
        let mut map = self.cancel.0.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&self.key);
    }

    /// 使い終わった接続とトンネルを閉じる。
    /// 先に登録を消しておくと、この後に「中止」が始まることがなくなる
    async fn close(mut self) {
        self.unregister();
        if let Some(c) = self.conn.take() {
            close_conn_gracefully(c).await;
        }
        // 踏み台へも切断を伝える (伝えないと相手側に異常切断として残る)
        if let Some(t) = self.tunnel.as_mut() {
            t.close().await;
        }
    }
}

impl Drop for SchemaConn {
    fn drop(&mut self) {
        self.unregister();
    }
}

/// スキーマ収集用にもう1本つなぐ。
///
/// Noneを返したときは呼び出し側がタブの接続で集める。
/// - SQLite / Valkey は専用接続の意味が無い
/// - 接続数の上限などで張れなかった場合も、失敗させずにタブの接続へ譲る
async fn open_schema_conn(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<Option<SchemaConn>, String> {
    let arc = get_session(sessions, session_id).await?;

    /*
     * 接続先の情報だけを写し取ってロックを離す。
     * ここから先はタブを止めない (逆に、タブが長いSQLを実行している間は
     * この1行で待たされる。写し取るだけなので待ちは一瞬では済まないが、
     * 収集そのものはタブと並行して走る)
     */
    let (profile, cancel) = {
        let guard = arc.lock().await;
        (guard.profile.clone(), guard.cancel.clone())
    };
    if !matches!(profile.db_type, DbType::Mysql | DbType::Postgresql) {
        return Ok(None);
    }
    let label = format!("{} (スキーマ収集)", conn_label(&profile));
    match connect_schema_conn(&profile, &label, cancel, session_id, qlog, database).await {
        Ok(sc) => Ok(Some(sc)),
        Err(e) => {
            // 接続数の上限・踏み台の同時接続数などで張れないことがある。
            // 以前と同じくタブの接続で集めれば、機能そのものは使える
            qlog.add(
                &label,
                database,
                &format!("-- 収集用の接続を開けないため、タブの接続で集めます ({e})"),
            );
            Ok(None)
        }
    }
}

/// 収集用の接続を1本張って、中止できるよう登録する
async fn connect_schema_conn(
    profile: &ConnectionProfile,
    label: &str,
    cancel: CancelRegistry,
    session_id: &str,
    qlog: &QueryLog,
    database: &str,
) -> Result<SchemaConn, String> {
    // トンネルも自前で張る。セッション側が張り直しても収集が切れないようにする
    let ep = db::resolve_endpoint(profile).await?;
    let via_ssh = ep.tunnel.is_some();
    let tls = db::TlsConfig::from_profile(profile, via_ssh);
    let conn = match profile.db_type {
        // MySQLはDB名を明示して information_schema を引くため、接続先DBは指定しない
        DbType::Mysql => DbConn::MySql(
            db::connect_mysql(
                &ep.host,
                ep.port,
                &profile.user,
                &profile.password,
                None,
                &tls,
            )
            .await?,
        ),
        // PostgreSQLは対象のDBにつながっていないとカタログが見えない
        _ => DbConn::Pg(
            db::connect_pg(
                &ep.host,
                ep.port,
                &profile.user,
                &profile.password,
                Some(database),
                &tls,
            )
            .await?,
        ),
    };

    let mut sc = SchemaConn {
        conn: Some(conn),
        label: label.to_string(),
        cancel,
        key: schema_cancel_key(session_id),
        tunnel: ep.tunnel,
    };

    // 読み取り専用の接続なら、収集用の接続にも同じ縛りを掛ける
    let prepared = async {
        if profile.read_only {
            let label = sc.label.clone();
            apply_read_only(sc.conn(), qlog, &label, database).await?;
        }
        fetch_conn_id(sc.conn()).await
    }
    .await;
    let conn_id = match prepared {
        Ok(id) => id,
        Err(e) => {
            sc.close().await;
            return Err(e);
        }
    };
    qlog.add(
        label,
        database,
        &format!("-- 収集用の接続を開きました (接続ID {conn_id})"),
    );

    // 「中止」ボタンから止められるようにする
    let sqlite_cancel = install_sqlite_cancel(sc.conn()).await;
    sc.cancel.0.lock().unwrap().insert(
        sc.key.clone(),
        CancelTarget {
            db_type: profile.db_type,
            label: sc.label.clone(),
            host: ep.host.clone(),
            port: ep.port,
            user: profile.user.clone(),
            password: zeroize::Zeroizing::new(profile.password.clone()),
            conn_id,
            tls: profile.tls,
            tls_sni: via_ssh.then(|| profile.host.clone()),
            db_tls: tls,
            sqlite_cancel,
        },
    );
    Ok(sc)
}

/// スキーマスナップショットを返す (差分ビューア・ER図・スキーマ一覧用)
pub async fn schema_snapshot(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<Vec<SchemaEntry>, String> {
    if let Some(mut sc) = open_schema_conn(sessions, qlog, session_id, database).await? {
        let label = sc.label.clone();
        let result = collect_schema_conn(sc.conn(), qlog, &label, database).await;
        sc.close().await;
        return result;
    }
    // SQLite / Valkey はタブの接続で集める
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    collect_schema_local(session, qlog, database).await
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
        read_only: s.profile.read_only,
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
    let items = schema_snapshot(sessions, qlog, session_id, database).await?;

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
        // 接続を張り直すと未コミットの変更が消えるので、黙って捨てない
        if session.txn == TxnState::User {
            return Err(USER_TXN_MSG.to_string());
        }
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
            &db::TlsConfig::from_profile(&session.profile, session.tunnel.is_some()),
        )
        .await?;
        // 旧接続はTerminateを送って閉じる
        let old = std::mem::replace(&mut session.conn, DbConn::Pg(new_conn));
        close_conn_gracefully(old).await;
        session.current_db = Some(database.to_string());
        // 新しい接続にトランザクションは無い (旧接続の分はサーバーが巻き戻す)
        session.txn = TxnState::None;
        // 接続が変わったので方言を解決し直す
        session.dialect = resolve_dialect(
            session.profile.db_type,
            &mut session.conn,
            qlog,
            &conn_label(&session.profile),
            database,
        )
        .await;
        if session.profile.read_only {
            let label = conn_label(&session.profile);
            // 読み取り専用を掛けられなかった接続は使わせない (次の操作で張り直す)
            if let Err(e) = apply_read_only(&mut session.conn, qlog, &label, database).await {
                session.txn = TxnState::Broken;
                return Err(e);
            }
        }
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
    confirmed: bool,
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
    let hits = match &mut session.conn {
        DbConn::MySql(c) => crate::search::mysql_objects(c, &db_label, keyword, &ctx).await,
        DbConn::Pg(c) => crate::search::pg_objects(c, &db_label, keyword, &ctx).await,
        DbConn::Sqlite(c) => crate::search::sqlite_objects(c, keyword, &ctx).await,
        DbConn::Kv(_) => unreachable!(),
    }?;
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
    let columns = match &mut session.conn {
        DbConn::MySql(c) => crate::search::mysql_value_columns(c, &db_label, &ctx).await?,
        DbConn::Pg(c) => crate::search::pg_value_columns(c, &ctx).await?,
        DbConn::Sqlite(c) => crate::search::sqlite_value_columns(c, &ctx).await?,
        DbConn::Kv(_) => unreachable!(),
    };
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

/// セッションを破棄する。DB・SSHとも終了通知を送ってから閉じる
pub async fn disconnect(
    sessions: &Sessions,
    cancel: &CancelRegistry,
    qlog: &QueryLog,
    jobs: &crate::csv_job::CsvJobs,
    session_id: &str,
) {
    /*
     * CSV取り込みなどの時間のかかる処理は、切れ目ごとに中止の印を見ている。
     * サーバーへのKILLより先に印を立てておけば、
     * 途中の1文が止まっても次のバッチへ進んでも、必ず中止として終われる
     * (取り込みは中止ならROLLBACKする)。
     * KILLが効かないSQLiteでもこちらは効く
     */
    jobs.cancel_session(session_id);

    let removed = sessions.0.lock().await.remove(session_id);
    // 1回目とマップから外す間に始まったジョブを取りこぼさない
    // (これ以降に始まるものは、セッションが見つからず動き出せない)
    jobs.cancel_session(session_id);
    let running = removed.as_ref().is_some_and(|arc| arc.try_lock().is_err());
    // 実行中のまま閉じられた場合、サーバー側のクエリは走り続けるので
    // 接続情報を捨てる前に一度だけ中止を試みる
    if running {
        let _ = cancel_query(cancel, qlog, session_id).await;
    }
    // スキーマ収集はセッションのロックを取らないので running では判断できない。
    // 走っていれば止める (走っていなければ何もしない)
    let _ = cancel_schema_load(cancel, qlog, session_id).await;
    // 接続情報 (パスワードを含む) はセッションの状態にかかわらずここで捨てる。
    // 実行中に閉じた場合、以前はレジストリに残り続けていた
    let prefix = schema_cancel_prefix(session_id);
    cancel
        .0
        .lock()
        .unwrap()
        .retain(|k, _| k != session_id && !k.starts_with(&prefix));
    if let Some(arc) = removed {
        match Arc::try_unwrap(arc) {
            Ok(m) => close_session_gracefully(m.into_inner(), qlog).await,
            // クエリ実行中に切断された場合: 実行タスクの完了時にArcごと破棄される
            Err(_) => {}
        }
    }
}

/// テストから状態を作るための入口 (本番コードからは使わない)
#[cfg(test)]
async fn set_txn_for_test(sessions: &Sessions, session_id: &str, txn: TxnState) {
    let arc = sessions.0.lock().await.get(session_id).cloned().unwrap();
    arc.lock().await.txn = txn;
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

    #[test]
    fn 後始末が要る状態だけ手を入れる() {
        // Quelioが張ったまま残った・後始末に失敗した → 片付ける
        assert!(txn_cleanup_note(TxnState::Open).is_some());
        assert!(txn_cleanup_note(TxnState::Broken).is_some());
        // 通常は何もしない (毎回張り直すと遅くなる)
        assert!(txn_cleanup_note(TxnState::None).is_none());
        // 利用者が自分で開いたトランザクションは正当なので勝手に閉じない
        assert!(txn_cleanup_note(TxnState::User).is_none());
    }

    #[test]
    fn トランザクションが無いという応答は成功とみなす() {
        assert!(no_txn_error("cannot rollback - no transaction is active"));
        assert!(no_txn_error("DBエラー: There is no transaction in progress"));
        assert!(!no_txn_error("DBエラー: 接続が切断されました"));
    }

    /// テスト用のSQLiteセッション一式を作る
    /// (ファイルはテストごと・プロセスごとに分ける)
    struct TestSession {
        sessions: Sessions,
        qlog: QueryLog,
        cancel: CancelRegistry,
        path: std::path::PathBuf,
    }

    async fn sqlite_session(name: &str) -> TestSession {
        let path = std::env::temp_dir()
            .join(format!("quelio_txn_{name}_{}.db", std::process::id()));
        cleanup_db(&path);
        std::fs::File::create(&path).unwrap();
        let profile: ConnectionProfile = serde_json::from_str(&format!(
            r#"{{"name":"t","dbType":"sqlite","host":"","port":0,"user":"","database":{}}}"#,
            serde_json::to_string(&path.to_string_lossy()).unwrap()
        ))
        .unwrap();
        let sessions = Sessions::default();
        let cancel = CancelRegistry::default();
        let qlog = QueryLog::default();
        let jobs = crate::csv_job::CsvJobs::default();
        connect(&sessions, &cancel, &qlog, &jobs, "s1".into(), profile)
            .await
            .unwrap();
        TestSession {
            sessions,
            qlog,
            cancel,
            path,
        }
    }

    /// 本体とWAL・共有メモリのファイルをまとめて消す
    fn cleanup_db(path: &std::path::Path) {
        for suffix in ["", "-wal", "-shm"] {
            let mut p = path.as_os_str().to_os_string();
            p.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(p));
        }
    }

    /// テスト用にSQLを1本実行する
    async fn run(sessions: &Sessions, qlog: &QueryLog, sql: &str) -> Result<RunOutput, String> {
        run_query(
            sessions, qlog, "s1", None, sql, 0, None, None, false, None, 30,
            &Default::default(),
        )
        .await
    }

    #[tokio::test]
    async fn 途中で失敗したddlはトランザクションを残さない() {
        let TestSession {
            sessions, qlog, path, ..
        } = sqlite_session("ddl").await;

        // 1文目は通り、2文目が構文エラー → まとめて取り消される
        let err = exec_ddl(
            &sessions,
            &qlog,
            "s1",
            None,
            &["CREATE TABLE u(a INTEGER)".into(), "CREATE TABLE".into()],
        )
        .await
        .unwrap_err();
        assert!(err.contains("取り消されました"), "{err}");

        /*
         * 同じ名前でもう一度作れれば、
         * 1文目が残っておらず、トランザクションも開いたままでないと分かる
         * (開いたままなら SQLite は入れ子の BEGIN でエラーになる)
         */
        exec_ddl(
            &sessions,
            &qlog,
            "s1",
            None,
            &["CREATE TABLE u(b INTEGER)".into(), "CREATE INDEX i ON u(b)".into()],
        )
        .await
        .unwrap();

        cleanup_db(&path);
    }

    #[tokio::test]
    async fn 残ったトランザクションは次の操作の入口で片付ける() {
        let TestSession {
            sessions, qlog, path, ..
        } = sqlite_session("stale").await;

        // 後始末に失敗した状態を作る
        set_txn_for_test(&sessions, "s1", TxnState::Broken).await;
        // 次の操作は、その後始末をしてから普通に通る
        exec_ddl(&sessions, &qlog, "s1", None, &["CREATE TABLE t(a INTEGER)".into()])
            .await
            .unwrap();

        // 開いたままの状態でも同じ
        set_txn_for_test(&sessions, "s1", TxnState::Open).await;
        run(&sessions, &qlog, "SELECT 1").await.unwrap();

        cleanup_db(&path);
    }

    #[tokio::test]
    async fn 利用者が開いたトランザクションの上に重ねない() {
        let TestSession {
            sessions, qlog, path, ..
        } = sqlite_session("user").await;
        exec_ddl(&sessions, &qlog, "s1", None, &["CREATE TABLE t(a INTEGER)".into()])
            .await
            .unwrap();

        // 利用者がSQLに直接 BEGIN を書く
        run(&sessions, &qlog, "BEGIN; INSERT INTO t VALUES (1)")
            .await
            .unwrap();

        // 変更系の操作は、閉じるまで断る
        let err = exec_ddl(&sessions, &qlog, "s1", None, &["CREATE TABLE u(a INTEGER)".into()])
            .await
            .unwrap_err();
        assert!(err.contains("COMMIT"), "{err}");
        // 入れ子の BEGIN も断る
        let err = run(&sessions, &qlog, "BEGIN").await.unwrap_err();
        assert!(err.contains("COMMIT"), "{err}");
        // 参照は今までどおりできる (自分のトランザクションの中が見える)
        run(&sessions, &qlog, "SELECT * FROM t").await.unwrap();

        // COMMIT すれば元どおり操作できる
        run(&sessions, &qlog, "COMMIT").await.unwrap();
        exec_ddl(&sessions, &qlog, "s1", None, &["CREATE TABLE u(a INTEGER)".into()])
            .await
            .unwrap();

        cleanup_db(&path);
    }

    #[tokio::test]
    async fn 切断は動いているジョブに中止を伝える() {
        let TestSession {
            sessions,
            qlog,
            cancel,
            path,
        } = sqlite_session("cancel").await;
        let jobs = crate::csv_job::CsvJobs::default();
        let job = jobs.start("j1", "s1");
        // 別のタブのジョブは巻き添えにしない
        let other = jobs.start("j2", "s2");

        disconnect(&sessions, &cancel, &qlog, &jobs, "s1").await;

        // ジョブは自分でこの印を見て中止する (サーバーへのKILLに頼らない)
        assert!(job.is_cancelled());
        assert!(!other.is_cancelled());
        // セッションも片付いている
        assert!(sessions.0.lock().await.get("s1").is_none());
        cleanup_db(&path);
    }

    #[tokio::test]
    async fn 途中で中止した取り込みは入れたぶんも取り消す() {
        let TestSession {
            sessions, qlog, path, ..
        } = sqlite_session("import").await;
        exec_ddl(&sessions, &qlog, "s1", None, &["CREATE TABLE t(a INTEGER)".into()])
            .await
            .unwrap();

        /*
         * 1バッチ (SQLiteは最大400行) を何百回も回る大きさにする。
         * 短いと、途中で一度も実行を譲らないまま最後まで走り切ってしまい、
         * 中止が間に合わないことがある
         */
        let csv = path.with_extension("csv");
        let mut body = String::from("a\n");
        for i in 0..100_000 {
            body.push_str(&format!("{i}\n"));
        }
        std::fs::write(&csv, body).unwrap();

        let jobs = crate::csv_job::CsvJobs::default();
        let job = jobs.start("j1", "s1");

        let opts = crate::csv_import::CsvOptions {
            delimiter: Some(",".into()),
            encoding: Some("utf-8".into()),
            has_header: true,
        };
        let mapping = [(0, "a".to_string())];
        let importing = import_csv(
            &sessions,
            &qlog,
            "s1",
            None,
            None,
            "t",
            &csv,
            &opts,
            &mapping,
            crate::csv_import::ImportMode::Append,
            false,
            Some(&job),
        );
        // 1バッチ目が入ったのを見てから中止する (切断されたときと同じ状態)
        let cancelling = async {
            // 取り込みが進まないまま終わってもここで止まらないよう上限を付ける
            for _ in 0..1_000_000 {
                if job.rows() > 0 {
                    jobs.cancel_session("s1");
                    return true;
                }
                tokio::task::yield_now().await;
            }
            false
        };
        let (res, cancelled_midway) = tokio::join!(importing, cancelling);
        let res = res.unwrap();

        assert!(cancelled_midway, "1行も入らないうちに終わってしまった");
        assert!(job.rows() > 0, "取り消しの前に行が入っていること");
        assert!(res.cancelled, "中止が間に合わなかった (入った行数: {})", job.rows());
        assert_eq!(res.rows, 0);

        // 入っていたぶんも含めて、1行も残っていないこと (ROLLBACKされている)
        let out = run(&sessions, &qlog, "SELECT COUNT(*) FROM t").await.unwrap();
        assert_eq!(out.statements[0].result.rows[0][0].as_deref(), Some("0"));

        let _ = std::fs::remove_file(&csv);
        cleanup_db(&path);
    }

    #[tokio::test]
    async fn sqliteの長いクエリを中止できる() {
        let TestSession {
            sessions,
            qlog,
            cancel,
            path,
        } = sqlite_session("interrupt").await;

        // 何十億行も数える再帰CTE。放っておくと終わらない
        const HEAVY: &str = "WITH RECURSIVE c(i) AS (\
             SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 3000000000\
             ) SELECT COUNT(*) FROM c";

        let running = run(&sessions, &qlog, HEAVY);
        let stopping = async {
            // 走り出したのを見計らって中止する
            for _ in 0..50 {
                tokio::task::yield_now().await;
            }
            cancel_query(&cancel, &qlog, "s1").await
        };
        let (res, stop) = tokio::join!(running, stopping);

        // SQLiteでも中止を受け付ける (以前は「対応していません」を返していた)
        stop.unwrap();
        let err = res.unwrap().error.expect("中止されるはず");
        assert!(err.contains("中止"), "{err}");

        /*
         * 中止の印は次の操作の入口で落ちる。
         * 落ちていないと、この後のクエリまで打ち切られてしまう
         */
        let out = run(&sessions, &qlog, "SELECT 1").await.unwrap();
        assert_eq!(out.statements[0].result.rows[0][0].as_deref(), Some("1"));

        cleanup_db(&path);
    }

    #[test]
    fn 中断された文の後でトランザクションの状態を合わせる() {
        use TxnState::*;
        /*
         * SQLiteは書き込みの文を中断するとトランザクションごと巻き戻すので、
         * 「開いたまま」と思い込むとそのタブが変更操作を断り続けてしまう
         */
        assert_eq!(txn_after_cancel(DbType::Sqlite, User, false), None);
        // 読み取りの文なら巻き戻さないので、そのまま
        assert_eq!(txn_after_cancel(DbType::Sqlite, User, true), User);
        // MySQL・PostgreSQLは文だけが止まる (トランザクションは残る)
        assert_eq!(txn_after_cancel(DbType::Mysql, User, false), User);
        assert_eq!(txn_after_cancel(DbType::Postgresql, User, false), User);
        // Quelioが張ったトランザクションは、こちらの後始末に任せる
        assert_eq!(txn_after_cancel(DbType::Sqlite, Open, false), Open);
        assert_eq!(txn_after_cancel(DbType::Sqlite, Broken, false), Broken);
        assert_eq!(txn_after_cancel(DbType::Sqlite, None, false), None);
    }

    #[tokio::test]
    async fn 中止で打ち切られた取り込みも何も残さない() {
        let TestSession {
            sessions,
            qlog,
            cancel,
            path,
        } = sqlite_session("kill").await;
        exec_ddl(&sessions, &qlog, "s1", None, &["CREATE TABLE t(a INTEGER)".into()])
            .await
            .unwrap();

        let csv = path.with_extension("csv");
        let mut body = String::from("a\n");
        for i in 0..100_000 {
            body.push_str(&format!("{i}\n"));
        }
        std::fs::write(&csv, body).unwrap();

        let jobs = crate::csv_job::CsvJobs::default();
        let job = jobs.start("j1", "s1");
        let opts = crate::csv_import::CsvOptions {
            delimiter: Some(",".into()),
            encoding: Some("utf-8".into()),
            has_header: true,
        };
        let mapping = [(0, "a".to_string())];
        let importing = import_csv(
            &sessions, &qlog, "s1", None, None, "t", &csv, &opts, &mapping,
            crate::csv_import::ImportMode::Append, false, Some(&job),
        );
        /*
         * 印を立てるだけでなく、サーバー側 (SQLiteは接続自身) にも中止を送る。
         * 走っているINSERTがその場で打ち切られるので、
         * 「バッチの切れ目で気づく」のとは別の経路を通る
         */
        let stopping = async {
            for _ in 0..1_000_000 {
                if job.rows() > 0 {
                    jobs.cancel("j1");
                    let _ = cancel_query(&cancel, &qlog, "s1").await;
                    return true;
                }
                tokio::task::yield_now().await;
            }
            false
        };
        let (res, stopped) = tokio::join!(importing, stopping);
        assert!(stopped, "1行も入らないうちに終わってしまった");

        // 打ち切られてもエラーではなく「中止」として返る
        let res = res.unwrap();
        assert!(res.cancelled, "入った行数: {}", job.rows());
        assert_eq!(res.rows, 0);

        // SQLiteは中断で自分から巻き戻すが、こちらの後始末とも噛み合っていること
        let out = run(&sessions, &qlog, "SELECT COUNT(*) FROM t").await.unwrap();
        assert_eq!(out.statements[0].result.rows[0][0].as_deref(), Some("0"));

        let _ = std::fs::remove_file(&csv);
        cleanup_db(&path);
    }

    #[tokio::test]
    async fn トランザクション実行と手書きの制御文は混ぜない() {
        let TestSession {
            sessions, qlog, path, ..
        } = sqlite_session("mix").await;
        exec_ddl(&sessions, &qlog, "s1", None, &["CREATE TABLE t(a INTEGER)".into()])
            .await
            .unwrap();

        let err = run_query(
            &sessions, &qlog, "s1", None,
            "INSERT INTO t VALUES (1); COMMIT; INSERT INTO t VALUES (2)",
            0, None, None, true, None, 30, &Default::default(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("BEGIN / COMMIT / ROLLBACK"), "{err}");

        cleanup_db(&path);
    }
}
