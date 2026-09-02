//! アクティブなDB接続(セッション)の管理。
//!
//! セッションの型と、その中心にある処理 (SQLの実行・中止・一覧の取得) を置く。
//! 手順が長く独立しているものは下位モジュールへ分けている:
//! 接続 (connect) / トランザクション (txn) / 行の編集 (rows) /
//! CSV取り込み (csv) / DB・スキーマ操作 (database) /
//! スキーマ収集 (schema_load) / Valkey (kv_ops)。
//! 呼ぶ側 (commands.rs) から見た名前は今までどおり `sessions::〇〇`

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use sqlx::mysql::MySqlConnection;
use sqlx::postgres::PgConnection;
use sqlx::sqlite::SqliteConnection;
use sqlx::Connection;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

use crate::apperr::AppError;
use crate::catalog::{self, LogCtx};
use crate::db;
use crate::ddl;
use crate::export;
use crate::kv;
use crate::models::{
    ConnectInfo, ConnectionProfile, DbType, RunOutput, SchemaEntry, SessionSummary,
    StatementResult, TableDetail, TableInfo,
};
use crate::query;
use crate::query_log::QueryLog;
use crate::proxy::Forwarder;


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
pub struct CancelRegistry(std::sync::Arc<std::sync::Mutex<HashMap<String, CancelTarget>>>);

impl CancelRegistry {
    /*
     * 中止対象の表は、この型の中でだけ開く。
     *
     * 表を掴んだまま panic すると Mutex は「毒された」印が付くが、
     * ここでしているのは差し込みと取り出しだけで、中身は壊れていない。
     * 中止できなくなるほうが困るので、毒は無視して中を使う。
     * 呼ぶ側で unwrap と into_inner が混ざっていると、
     * 場所によって「止まる / 動く」が変わってしまうため、扱いを1か所に閉じる
     */
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancelTarget>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 中止対象として登録する (接続できたとき)
    pub(crate) fn register(&self, key: String, target: CancelTarget) {
        self.map().insert(key, target);
    }

    /// 登録を消す (この後は「中止」が届かなくなる)
    pub(crate) fn unregister(&self, key: &str) {
        self.map().remove(key);
    }

    /// 登録内容の写しを返す
    pub(crate) fn get(&self, key: &str) -> Option<CancelTarget> {
        self.map().get(key).cloned()
    }

    /// 登録があるか
    pub(crate) fn contains(&self, key: &str) -> bool {
        self.map().contains_key(key)
    }

    /// 登録内容を書き換える (無ければ何もしない)
    pub(crate) fn edit(&self, key: &str, f: impl FnOnce(&mut CancelTarget)) {
        if let Some(t) = self.map().get_mut(key) {
            f(t);
        }
    }

    /// 指定の頭文字で始まる鍵をすべて返す (スキーマ収集は1タブに複数ある)
    pub(crate) fn keys_with_prefix(&self, prefix: &str) -> Vec<String> {
        self.map()
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect()
    }

    /// このセッションに紐づく登録をすべて消す (切断のとき)
    pub(crate) fn drop_session(&self, session_id: &str, prefix: &str) {
        self.map()
            .retain(|k, _| k != session_id && !k.starts_with(prefix));
    }
}

/// SQLを扱う3種類の接続 (MySQL / PostgreSQL / SQLite) に、
/// 同じ処理を1回だけ書くためのマクロ。
///
/// sqlxは接続ごとに別の型で、クエリの型もそれに引きずられるため、
/// 関数として共通化するとトレイト境界だけが増えて読みにくくなる。
/// 中身がまったく同じところは、マクロで3回展開するほうが分かりやすい。
///
/// `$c` に接続が入る。Valkeyは `$kv` の文言で断る
macro_rules! with_sql_conn {
    ($conn:expr, $kv:expr, |$c:ident| $body:block) => {
        match $conn {
            DbConn::MySql($c) => $body,
            DbConn::Pg($c) => $body,
            DbConn::Sqlite($c) => $body,
            DbConn::Kv(_) => Err($kv.into()),
        }
    };
}

/*
 * 下位モジュール。
 * with_sql_conn マクロより後ろで宣言する (マクロは書いた順にしか効かない)
 */
/// Valkey (KV) の操作
mod kv_ops;
pub use kv_ops::*;

/// スキーマの収集 (ER図・差分ビューア用)
mod schema_load;
pub use schema_load::*;

/// データベース・スキーマの作成 / 削除 / 切り替え
mod database;
pub use database::*;

/// トランザクションの制御と後始末
mod txn;
pub use txn::*;

/// 接続の確立と生存確認
mod connect;
pub use connect::*;

/// 行・セル単位の読み書き (データタブの編集)
mod rows;
pub use rows::*;

/// CSV/TSVの取り込み
mod csv;
pub use csv::*;

/// 日本語のテストデータを作って入れる
mod testdata;
pub use testdata::*;

/// キャンセル用の接続IDが分からない状態を表す値。
///
/// サーバーが割り当てないIDにしておけば、この値のまま中止を送ろうとしても
/// 無関係な接続を止めることはない
const CONN_ID_UNKNOWN: i64 = -1;

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
    /// トンネル (SSH または外部CLI)。セッションが生きている間は保持し続ける
    tunnel: Option<Forwarder>,
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
    cancel.get(session_id).map(|t| t.db_type)
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

/// 定義変更のSQLを組み立てるときの書き方 (文字列の逃がし方が接続で変わる)。
///
/// 方言を読めなかったときは、そのDBの出荷時の設定にしておく。
/// MySQLは既定でバックスラッシュがエスケープなので、
/// 読めない場合も `\` を重ねる側 (＝文字列が閉じる側) に倒れる
pub async fn session_sql_style(
    sessions: &Sessions,
    session_id: &str,
) -> Result<ddl::SqlStyle, String> {
    let db = session_db_type(sessions, session_id).await?;
    Ok(match session_dialect(sessions, session_id).await {
        Some(d) => ddl::SqlStyle::from_dialect(db, &d),
        None => ddl::SqlStyle::of(db),
    })
}

/// セッションの環境ラベル ("prod" 等。未接続・未設定ならNone)。
///
/// 実行中は方言と同じくロックが取れないので諦める。
/// 実行中に別のSQLを流し始めることはできないため、
/// 確認の判定でこれが読めない場面は実際には起きない
pub async fn session_env(sessions: &Sessions, session_id: &str) -> Option<String> {
    let arc = sessions.0.lock().await.get(session_id).cloned()?;
    // ロックガードを式の途中で持ったままにしない (arc より長生きしてしまう)
    let env = arc.try_lock().ok().and_then(|s| s.profile.env.clone());
    env
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
        let bad = split
            .stmts
            .iter()
            .map(|s| (s, query::Analyzed::new(d, s)))
            .find(|(_, a)| !a.is_read_only());
        if let Some((stmt, a)) = bad {
            let head: String = stmt.chars().take(60).collect();
            // ロックが理由のときは、そうと分かる説明にする
            let msg = if a.locks_rows() {
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

/// 実行中のクエリをキャンセルする。
/// 実行中はセッションの接続が塞がっているため、別接続からKILL/pg_cancel_backendを送る
pub async fn cancel_query(
    cancel: &CancelRegistry,
    qlog: &QueryLog,
    session_id: &str,
) -> Result<(), String> {
    let target = cancel.get(session_id).ok_or("接続されていません")?;

    // 接続を張り直している最中はIDが決まっていない (送ると別の接続を止めかねない)
    if target.conn_id == CONN_ID_UNKNOWN {
        return Err("接続し直している最中のため、いまは中止できません".into());
    }

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
    let out = match &mut session.conn {
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
    };
    // 打ち切った接続は状態がずれうるので、次の操作で生存確認させる
    Ok(note_timeout(session, out)?)
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
    let out = match &mut session.conn {
        DbConn::MySql(conn) => catalog::mysql_collations(conn, &ctx).await,
        DbConn::Pg(conn) => catalog::pg_collations(conn, &ctx).await,
        // SQLiteの照合順序は型定義の一部で、後から変えられない
        DbConn::Sqlite(_) | DbConn::Kv(_) => Ok(Vec::new()),
    };
    // 打ち切った接続は状態がずれうるので、次の操作で生存確認させる
    Ok(note_timeout(session, out)?)
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

    let out = match &mut session.conn {
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
    };
    // 打ち切った接続は状態がずれうるので、次の操作で生存確認させる
    Ok(note_timeout(session, out)?)
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

    let out = match &mut session.conn {
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
    };
    // 打ち切った接続は状態がずれうるので、次の操作で生存確認させる
    Ok(note_timeout(session, out)?)
}
/// 任意のSQLを実行する。複数文はセミコロンで分割して逐次実行し、
/// エラーが出た時点で停止する (offsetは単文実行時のページング用)
/// BEGIN/COMMIT/ROLLBACK等の制御文を実行する
/// トランザクション制御などの1文を実行する。
///
/// 後始末の判断 (「そもそもトランザクションが無い」等) に使うので、
/// エラーは種類つきで返す
async fn exec_ctl(
    conn: &mut DbConn,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
    sql: &str,
) -> Result<(), AppError> {
    qlog.add(label, db_label, sql);
    with_sql_conn!(conn, "Valkey接続では使用できません", |c| {
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(&mut *c)
            .await
            .map(|_| ())
            .map_err(db::db_error)
    })
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
    /*
     * どのDBかは必ず網羅して見る。
     * 「MySQL以外はPostgreSQL」と書くと、Valkeyの接続に
     * PostgreSQLとして繋ぎ直そうとしてしまう
     */
    match &session.conn {
        // SQLiteは1ファイル=1DBのため切り替え不要
        DbConn::Sqlite(_) => Ok(()),
        // ValkeyのDB番号は専用の入口 (ensure_kv_db) で切り替える
        DbConn::Kv(_) => Err("Valkey接続ではデータベースを指定できません".to_string()),
        DbConn::Pg(_) => ensure_pg_database(session, db, qlog).await,
        // MySQL: 選択中DBが変わっていればUSEで切り替える
        DbConn::MySql(_) => {
            if session.current_db.as_deref() == Some(db.as_str()) {
                return Ok(());
            }
            let use_sql = format!("USE `{}`", db.replace('`', "``"));
            qlog.add(label, db, &use_sql);
            match &mut session.conn {
                DbConn::MySql(conn) => {
                    sqlx::raw_sql(sqlx::AssertSqlSafe(use_sql.clone()))
                        .execute(&mut *conn)
                        .await
                        .map_err(db::format_db_error)?;
                }
                _ => unreachable!("直前でMySQLだけに絞っている"),
            }
            session.current_db = Some(db.clone());
            Ok(())
        }
    }
}

/// SQL 1文の結果を全件CSVファイルへ書き出す。
/// 画面のページング (1000行) とは無関係に、対象SQLの全行を出力する。
/// jobを渡すと進捗の共有とキャンセルができる。
/// 戻り値は (書き出した行数, キャンセルされたか)
#[allow(clippy::too_many_arguments)]
pub async fn export_query_rows(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: Option<String>,
    sql: &str,
    order_by: Option<String>,
    order_dir: Option<String>,
    path: &std::path::Path,
    format: crate::export_rows::RowFormat,
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
    // 複数文をまとめて渡されると、どの結果を書き出すか決められない
    if stmts.len() > 1 {
        return Err(format!("{}出力は1つのSQLずつ行ってください", format.label()));
    }

    /*
     * 書き出しでも `SET …` は実行できるので、方言が変わったら聞き直す。
     * 聞き直しは実行の後 (成功・失敗どちらでも) に行う
     */
    let mut dialect_dirty = stmts
        .iter()
        .any(|st| query::changes_dialect(session.dialect, st));

    let mysql_quoting = matches!(session.conn, DbConn::MySql(_));
    let out_sql = query::plan_export(session.dialect, sql, order, mysql_quoting);
    qlog.add(&label, &db_label, &out_sql);

    /*
     * 書き出し先を用意する。
     *
     * CSVはその場でファイルを開いて1行ずつ流す。
     * Excelは中身が圧縮された書庫なので、最後の `finish` でまとめて書く
     * (それまでは一定メモリのモードで一時ファイルへ流れている)
     */
    let mut sink: Box<dyn crate::export_rows::RowSink> = match format {
        crate::export_rows::RowFormat::Csv => {
            // 中身はDBのデータなので、所有者だけが読める権限で作る
            let file = crate::outfile::create(path)
                .map_err(|e| format!("CSVを作成できません: {e}"))?;
            Box::new(crate::export_rows::CsvSink::new(std::io::BufWriter::new(
                file,
            )))
        }
        crate::export_rows::RowFormat::Xlsx => {
            Box::new(crate::export_sheet::SheetSink::new(path, "結果")?)
        }
    };

    // 読み取り専用の接続はプリペアドで送り、複数文をサーバー側でも弾く
    let mode = query::SqlMode::for_read_only(
        session.profile.read_only,
        session.txn != TxnState::None,
    );
    let res = match &mut session.conn {
        DbConn::MySql(conn) => {
            query::export_rows_mysql(conn, &out_sql, mode, sink.as_mut(), job).await
        }
        DbConn::Pg(conn) => query::export_rows_pg(conn, &out_sql, mode, sink.as_mut(), job).await,
        DbConn::Sqlite(conn) => {
            query::export_rows_sqlite(conn, &out_sql, mode, sink.as_mut(), job).await
        }
        DbConn::Kv(_) => unreachable!(),
    };
    refresh_dialect(session, qlog, &label, &db_label, &mut dialect_dirty).await;
    let (rows, cancelled) = res?;
    // 中止したファイルは呼び出し側が消すので、締めるのは最後まで書けたときだけ
    if !cancelled {
        sink.finish()?;
    }
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
            return Err(e.into());
        }
    }
    if use_txn {
        end_txn(session, qlog, &label, &db_label, true).await?;
    }
    Ok(())
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
    // 値そのものの形 (「数値」に数値以外が入っていないか) を先に見る
    query::check_params(params)?;
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
    /*
     * この後の判定 (実行計画の可否・トランザクション制御・方言の変化・
     * 中止後の状態合わせ) は、どれも同じ「文を伏せた形」を見る。
     * 文ごとに一度だけ作って使い回す (長いSQLでは判定の回数だけ待たされていた)
     */
    let analyzed: Vec<query::Analyzed> = stmts
        .iter()
        .map(|s| query::Analyzed::new(session.dialect, s))
        .collect();

    // EXPLAIN ANALYZE は対象のSQLを実際に実行して計測するため、
    // データが変わる可能性のあるSQLは受け付けない (SQLiteはEXPLAIN QUERY PLANなので対象外)
    if explain.as_deref() == Some("analyze") && !matches!(session.conn, DbConn::Sqlite(_)) {
        let bad = stmts
            .iter()
            .zip(&analyzed)
            .find(|(_, a)| !a.is_analyzable())
            .map(|(s, _)| s);
        if let Some(bad) = bad {
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
    let effects: Vec<Option<bool>> = analyzed.iter().map(|a| a.txn_effect(db_type)).collect();
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
    let mut dialect_dirty = analyzed.iter().any(|a| a.changes_dialect());
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

    /*
     * 「数値」「そのまま」の値はクォートせずに入るので、
     * 値を入れた後のSQLでもう一度だけ確かめる。
     *  - 文が増えていないか (値で2文目を足せないように)
     *  - 読み取り専用の接続で、更新系になっていないか
     * 判定そのものは埋め込み前に済ませているが、この2つだけは
     * 値がSQLの構造を変えられる余地があるため
     */
    if params
        .values()
        .any(|v| matches!(v.kind.as_str(), "raw" | "number"))
    {
        for f in &filled {
            let split = query::split_sql(dialect, f);
            if split.stmts.len() > 1 || split.unterminated.is_some() {
                return Err(concat!(
                    "パラメータの値でSQLが複数の文になりました。\n",
                    "「そのまま」の値に `;` や引用符の閉じ忘れが無いか確認してください"
                )
                .to_string());
            }
            if session.profile.read_only && !query::is_read_only(dialect, f) {
                return Err(READ_ONLY_MSG.to_string());
            }
        }
    }

    let mut statements: Vec<StatementResult> = Vec::new();
    for i in 0..stmts.len() {
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
                dialect,
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
                if e.is_cancelled() {
                    session.txn =
                        txn_after_cancel(db_type, session.txn, analyzed[i].is_read_only());
                }
                // タイムアウトは応答の途中で打ち切るため、接続の状態がずれうる。
                // 次の操作で必ず生存確認 (ping) が走るようにしておく
                if e.is_timeout() {
                    mark_needs_ping(session);
                }
                let mut msg = if single {
                    e.message
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
    let out = match &mut session.conn {
        DbConn::MySql(conn) => catalog::mysql_processes(conn, &ctx, log).await,
        DbConn::Pg(conn) => catalog::pg_processes(conn, &ctx, log).await,
        DbConn::Sqlite(_) => {
            Err("SQLiteはファイルを直接開くため、接続の一覧はありません".into())
        }
        DbConn::Kv(_) => Err("Valkey接続では使用できません".into()),
    };
    Ok(out?)
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
    let me = session.cancel.get(&session.id).map(|t| t.conn_id);
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
    let out = match &mut session.conn {
        DbConn::MySql(conn) => catalog::mysql_routines(conn, database, &ctx).await,
        DbConn::Pg(conn) => catalog::pg_routines(conn, &ctx).await,
        DbConn::Sqlite(conn) => catalog::sqlite_routines(conn, &ctx).await,
        DbConn::Kv(_) => Err("Valkey接続では使用できません".into()),
    };
    // 打ち切った接続は状態がずれうるので、次の操作で生存確認させる
    Ok(note_timeout(session, out)?)
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
    let out = match &mut session.conn {
        DbConn::MySql(conn) => {
            catalog::mysql_table_ddl(conn, &db_label, table, &ctx).await
        }
        DbConn::Pg(conn) => {
            let schema = schema.unwrap_or_else(|| "public".to_string());
            catalog::pg_table_ddl(conn, &schema, table, &ctx).await
        }
        DbConn::Sqlite(conn) => catalog::sqlite_table_ddl(conn, table, &ctx).await,
        DbConn::Kv(_) => Err("Valkey接続では使用できません".into()),
    };
    // 打ち切った接続は状態がずれうるので、次の操作で生存確認させる
    Ok(note_timeout(session, out)?)
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
    // 画面で選んだTLSの設定を外部ツールにも渡す。
    // トンネル経由では接続先が127.0.0.1になるので、
    // アプリ本体と同じくホスト名の検証はCA検証まで落ちる
    let tls = db::TlsConfig::from_profile(&s.profile, s.tunnel.is_some());
    Ok(crate::tools::Endpoint {
        db_type: s.profile.db_type,
        host: s.host.clone(),
        port: s.port,
        user: s.profile.user.clone(),
        password: s.profile.password.clone(),
        read_only: s.profile.read_only,
        tls,
    })
}
/// タイムアウトで打ち切ったときは、次の操作で必ず生存確認 (ping) を走らせる。
///
/// 応答を最後まで受け取らずに切っているため、接続に結果が残っていることがある。
/// そのまま次の問い合わせに使うと、前の結果を読んでしまいかねない
fn note_timeout<T>(session: &mut Session, res: Result<T, AppError>) -> Result<T, AppError> {
    if res.as_ref().err().is_some_and(|e| e.is_timeout()) {
        mark_needs_ping(session);
    }
    res
}

/// 次の操作の入口で必ず生存確認が走るように、最終使用時刻を巻き戻す
fn mark_needs_ping(session: &mut Session) {
    session.last_used = std::time::Instant::now()
        .checked_sub(IDLE_PING_AFTER)
        .unwrap_or_else(std::time::Instant::now);
}

/// 画面に出すトランザクションの状態。
///
/// 利用者がSQLに書いた BEGIN も、中断されて残ったものも、
/// 「開いていて閉じないと確定しない」ことに変わりはないのでまとめて open にする
pub fn txn_status(txn: TxnState) -> &'static str {
    match txn {
        TxnState::None => "none",
        TxnState::Open | TxnState::User => "open",
        TxnState::Broken => "broken",
    }
}

/// 今のトランザクションの状態を返す (ステータスバーの表示用)。
///
/// 実行中はロックが取れないので "busy" を返して今の表示のままにしてもらう。
/// ここで待つと、長いSQLの間じゅう画面が固まってしまう
pub async fn txn_state(sessions: &Sessions, session_id: &str) -> Result<String, String> {
    let arc = get_session(sessions, session_id).await?;
    // ロックガードを式の途中で持ったままにしない (arc より長生きしてしまう)
    let state = match arc.try_lock() {
        Ok(guard) => txn_status(guard.txn),
        Err(_) => "busy",
    };
    Ok(state.to_string())
}

/// 開いているトランザクションを閉じる (ステータスバーのボタンから呼ぶ)。
/// 閉じたあとの状態を返す
pub async fn end_open_txn(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    commit: bool,
) -> Result<String, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    // 待っている間に別の操作が閉じていることがある (二重に押した場合など)
    if session.txn == TxnState::None {
        return Ok("none".to_string());
    }
    let label = conn_label(&session.profile);
    let db_label = session.current_db.clone().unwrap_or_default();
    end_txn(session, qlog, &label, &db_label, commit).await?;
    Ok(txn_status(session.txn).to_string())
}

/// キャンセル用の接続IDを「不明」に戻す (接続を差し替えるのと同じ場所で呼ぶ)。
///
/// await を挟まずに書き換えるので、この後の処理が途中で打ち切られても
/// 古いIDが残らない。残ったままだと、サーバーが同じ番号を
/// 割り当て直したあとの「中止」が無関係な接続を止めてしまう
fn invalidate_cancel_conn(session: &Session) {
    session.cancel.edit(&session.id, |t| {
        t.conn_id = CONN_ID_UNKNOWN;
        // SQLiteの中止の印も、古い接続のものは効かない
        t.sqlite_cancel = None;
    });
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
    cancel.drop_session(session_id, &prefix);
    // 誰も掴んでいなければ、終了通知を送ってから閉じる。
    // クエリ実行中に切断された場合は掴まれたままなので、
    // 実行タスクの完了時にArcごと破棄される
    if let Some(arc) = removed {
        if let Ok(m) = Arc::try_unwrap(arc) {
            close_session_gracefully(m.into_inner(), qlog).await;
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
        // 判定はDBが返す英語メッセージを見るので db.rs に置いてある
        assert!(db::is_no_txn_message(
            "cannot rollback - no transaction is active"
        ));
        assert!(db::is_no_txn_message(
            "DBエラー: There is no transaction in progress"
        ));
        assert!(!db::is_no_txn_message("DBエラー: 接続が切断されました"));
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
