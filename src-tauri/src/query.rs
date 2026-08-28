//! 任意のSQL実行と結果セットの文字列化。
//!
//! この階層には「実際にサーバーへ送って読み取るところ」だけを置く。
//! 送る前に決めることは下位モジュールへ分けている:
//! 字句解析と文の分割 (lexer) / パラメータの埋め込み (params) /
//! 文の種類の判定 (classify) / 実行するSQLの組み立て (plan) /
//! 結果のセルの文字列化 (cells)。
//! 呼ぶ側から見た名前は今までどおり `query::〇〇`

use std::time::Instant;

use futures_util::{Stream, TryStreamExt};
use sqlx::mysql::{MySqlConnection, MySqlRow};
use sqlx::postgres::{PgConnection, PgRow};
use sqlx::sqlite::{SqliteConnection, SqliteRow};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use tokio::time::{timeout, Duration};

use crate::csv_job::CsvJob;
use crate::apperr::AppError;
use crate::db::db_error;
use crate::export::CsvCell;
use crate::models::{DbType, QueryResult};

/// SQL実行タイムアウトの既定値 (秒)。設定画面から変更できる
pub const DEFAULT_QUERY_TIMEOUT_SECS: u64 = 60;

/// 字句解析と文の分割
mod lexer;
pub use lexer::*;

/// パラメータの埋め込み
mod params;
pub use params::*;

/// SQLの種類の判定
mod classify;
pub use classify::*;

/// 実行するSQLの組み立て
mod plan;
pub use plan::*;

/// 結果のセルの文字列化
mod cells;
pub use cells::*;

/// SQL実行タイムアウト。0は無制限 (実装上は十分大きな値) として扱う
pub fn query_timeout(secs: u64) -> Duration {
    if secs == 0 {
        Duration::from_secs(60 * 60 * 24 * 365)
    } else {
        Duration::from_secs(secs)
    }
}

/// 1ページの行数
pub const PAGE_SIZE: usize = 1000;

/// 1セルとして画面へ返す最大文字数。
/// 長大なTEXT/JSON列をそのまま持つとメモリを圧迫するため、超えた分は切り詰める
pub const MAX_CELL_CHARS: usize = 1000;

/// 「全文を取得」で返す最大文字数。
/// 画面用の上限は外すが、数百MBの値をそのまま画面へ渡すと固まるため上限は残す
pub const FETCH_CELL_MAX: usize = 1_000_000;

/// SQLの書き方の違い。文の分割で見分けが要るものだけを持つ
#[derive(Clone, Copy, PartialEq)]
pub struct Dialect {
    /// 文字列の中でバックスラッシュがエスケープになるか (MySQL)
    pub backslash_escape: bool,
    /// # から行末までがコメントか (MySQL)。
    /// PostgreSQLでは #> などの演算子なのでコメントにしてはいけない
    pub hash_comment: bool,
    /// $$ … $$ / $tag$ … $tag$ の引用符があるか (PostgreSQL)
    pub dollar_quote: bool,
    /// E'…' と前置きした文字列だけバックスラッシュがエスケープになるか (PostgreSQL)。
    /// standard_conforming_strings が on でも E'…' は常にエスケープを解釈する
    pub e_string: bool,
    /// " が文字列ではなく識別子の引用符か (MySQLの sql_mode = ANSI_QUOTES)。
    /// 識別子の引用符の中ではバックスラッシュはただの文字になる
    pub ansi_quotes: bool,
    /// -- が行コメントになるには直後に空白が要るか (MySQL)。
    /// MySQLの `1--2` は引き算であってコメントではない
    pub dash_needs_space: bool,
    /// `/*! … */` の中身をサーバーが実行するか (MySQL)。
    /// コメントとして読み飛ばすと、中に書かれたSQLを見落とす
    pub exec_comment: bool,
    /// ブロックコメントが入れ子にできるか (PostgreSQL)
    pub nested_comment: bool,
}

impl Dialect {
    pub const MYSQL: Dialect = Dialect {
        backslash_escape: true,
        hash_comment: true,
        dollar_quote: false,
        e_string: false,
        ansi_quotes: false,
        dash_needs_space: true,
        exec_comment: true,
        nested_comment: false,
    };
    pub const POSTGRESQL: Dialect = Dialect {
        backslash_escape: false,
        hash_comment: false,
        dollar_quote: true,
        e_string: true,
        ansi_quotes: false,
        dash_needs_space: false,
        exec_comment: false,
        nested_comment: true,
    };
    pub const SQLITE: Dialect = Dialect {
        backslash_escape: false,
        hash_comment: false,
        dollar_quote: false,
        e_string: false,
        ansi_quotes: false,
        dash_needs_space: false,
        exec_comment: false,
        nested_comment: false,
    };

    /// DBの種類から見た既定の方言。
    /// 実際の方言はサーバーの設定 (MySQLのsql_mode、PostgreSQLの
    /// standard_conforming_strings) で変わるため、接続後は
    /// `crate::dialect::resolve` で解決した値を使うこと
    pub fn of(db: DbType) -> Dialect {
        match db {
            DbType::Mysql => Dialect::MYSQL,
            DbType::Postgresql => Dialect::POSTGRESQL,
            _ => Dialect::SQLITE,
        }
    }
}

/// 結果セットのストリームから1ページ分 (PAGE_SIZE行) だけ読み取る。
///
/// PAGE_SIZE+1行目が届いた時点で読み取りを打ち切ってストリームを閉じるため、
/// LIMITを付けられないSQL (LIMIT指定済み・SHOW等) で結果が何百万行あっても、
/// アプリが保持する行数は常に1ページ分に収まる。
/// 戻り値は (カラム名, 行データ, 次ページの有無)
/// 1ページぶんの読み取り結果 (行と、切り詰めたセルの位置)
struct Page {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    clipped: Vec<ClippedCell>,
    has_more: bool,
}

async fn fetch_page<R, S>(
    mut stream: S,
    cell: fn(&R, usize) -> CellText,
    limit: usize,
) -> Result<Page, AppError>
where
    R: Row,
    S: Stream<Item = Result<R, sqlx::Error>> + Unpin,
{
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut clipped: Vec<ClippedCell> = Vec::new();
    let mut has_more = false;
    while let Some(row) = stream.try_next().await.map_err(db_error)? {
        if columns.is_empty() {
            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
        }
        if rows.len() >= limit {
            // 次のページがあることが分かれば十分なので、ここで読み取りをやめる
            has_more = true;
            break;
        }
        let at = rows.len();
        let mut cells: Vec<Option<String>> = Vec::with_capacity(row.columns().len());
        for i in 0..row.columns().len() {
            match cell(&row, i) {
                Some((text, clip)) => {
                    if let Some(c) = clip {
                        clipped.push(ClippedCell {
                            row: at,
                            col: i,
                            head: c.head,
                            total: c.total,
                        });
                    }
                    cells.push(Some(text));
                }
                None => cells.push(None),
            }
        }
        rows.push(cells);
    }
    Ok(Page {
        columns,
        rows,
        clipped,
        has_more,
    })
}

/// 結果セットのストリームをCSVとして書き出す。
/// 1行ずつ書き出すので、何百万行でもメモリ使用量は一定。
/// 戻り値は (書き出した行数, キャンセルされたか)
async fn write_csv<R, S, W>(
    mut stream: S,
    cell: fn(&R, usize) -> Option<CsvCell>,
    out: &mut W,
    job: Option<&CsvJob>,
) -> Result<(usize, bool), AppError>
where
    R: Row,
    S: Stream<Item = Result<R, sqlx::Error>> + Unpin,
    W: std::io::Write,
{
    let mut count = 0usize;
    let mut wrote_header = false;
    loop {
        /*
         * 中止を押すとサーバー側からも1本を止めに行くので、
         * 1行目が返る前でも、その結果のエラーとして返ってくる。
         * 失敗ではなく「中止」として扱う
         */
        let next = match stream.try_next().await {
            Ok(v) => v,
            Err(e) => {
                if job.is_some_and(|j| j.is_cancelled()) {
                    return Ok((count, true));
                }
                return Err(db_error(e));
            }
        };
        let Some(row) = next else { break };
        if !wrote_header {
            let cols: Vec<Option<CsvCell>> = row
                .columns()
                .iter()
                .map(|c| Some(CsvCell::text(c.name().to_string())))
                .collect();
            out.write_all(crate::export::csv_row_cells(&cols).as_bytes())
                .map_err(|e| format!("CSVを書き込めません: {e}"))?;
            wrote_header = true;
        }
        // 文字列・日時はクォートで囲み、数値はそのまま、NULLは空欄にする
        let fields: Vec<Option<CsvCell>> = (0..row.columns().len())
            .map(|i| cell(&row, i))
            .collect();
        out.write_all(crate::export::csv_row_cells(&fields).as_bytes())
            .map_err(|e| format!("CSVを書き込めません: {e}"))?;
        count += 1;
        // 進捗の共有とキャンセル要求の確認 (どちらもアトミック変数なので軽い)
        if let Some(job) = job {
            job.set_rows(count);
            if job.is_cancelled() {
                return Ok((count, true));
            }
        }
    }
    Ok((count, false))
}

/// SQLの実行方法。
///
/// `Raw` はテキストプロトコル (simple query) でそのまま送る。
/// `Prepared` はプリペアドステートメント (extended query) で送る。
/// MySQL (COM_STMT_PREPARE) と PostgreSQL (Parse) は1回に1文しか受け付けないため、
/// 字句解析が方言を取り違えて文の切れ目を見落としても、
/// 意図しない2文目がサーバー側で弾かれる (多層防御)。
///
/// SQLiteのドライバは1つの文字列を `;` で割ってすべて実行するため、
/// この保護は効かない。SQLiteの読み取り専用接続は
/// ファイルを SQLITE_OPEN_READONLY で開くことで守っている
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum SqlMode {
    Raw,
    /// プリペアドで送る。
    /// `retry_text` は、バイナリ形式で受け取れない型に当たったときに
    /// テキスト形式でやり直してよいか (トランザクションの中では不可)
    Prepared { retry_text: bool },
}

impl SqlMode {
    /// 読み取り専用の接続ではプリペアドで送る。
    ///
    /// トランザクションが開いている間は、1度エラーになると
    /// PostgreSQLはそのトランザクション全体を中断状態にするため、
    /// やり直しても必ず失敗する (本来のエラーも見えなくなる)
    pub fn for_read_only(read_only: bool, in_txn: bool) -> SqlMode {
        if read_only {
            SqlMode::Prepared {
                retry_text: !in_txn,
            }
        } else {
            SqlMode::Raw
        }
    }

    fn prepared(self) -> bool {
        matches!(self, SqlMode::Prepared { .. })
    }
}

/*
 * 実行と書き出しの中身は、MySQL / PostgreSQL / SQLite で完全に同じ。
 * 違うのは「接続の型」と「セルの読み方」だけで、
 * sqlxは接続ごとに別の型なので、関数にまとめるとトレイト境界だけが増える。
 * 中身がそのまま同じところは、マクロで3回展開するほうが流れが読める
 */

/// 結果セットのストリームを開く (プリペアド / そのまま送るの違いだけ)
macro_rules! fetch_stream {
    ($conn:expr, $sql:expr, $mode:expr) => {
        if $mode.prepared() {
            sqlx::query(sqlx::AssertSqlSafe($sql))
                .persistent(false)
                .fetch(&mut *$conn)
        } else {
            sqlx::raw_sql(sqlx::AssertSqlSafe($sql)).fetch(&mut *$conn)
        }
    };
}

/// SQLの結果を全件CSVへ書き出す
macro_rules! export_csv_impl {
    ($conn:expr, $sql:expr, $mode:expr, $out:expr, $job:expr, $cell:path) => {{
        let stream = fetch_stream!($conn, $sql.to_string(), $mode);
        write_csv(stream, $cell, $out, $job).await
    }};
}

/// 1文を実行する。
/// 結果を返す文は1ページ分だけ読み、それ以外は影響した行数を返す
macro_rules! run_impl {
    ($conn:expr, $plan:expr, $mode:expr, $secs:expr, $cell:path, $cell_all:path) => {{
        let started = Instant::now();
        if $plan.is_fetch {
            let stream = fetch_stream!($conn, $plan.sql.clone(), $mode);
            let page = timeout(
                query_timeout($secs),
                fetch_page(
                    stream,
                    if $plan.full { $cell_all } else { $cell },
                    if $plan.full { usize::MAX } else { PAGE_SIZE },
                ),
            )
            .await
            .map_err(|_| AppError::timeout("クエリ"))??;

            Ok(QueryResult {
                columns: page.columns,
                rows: page.rows,
                clipped: page.clipped,
                offset: $plan.offset,
                has_more: page.has_more,
                pageable: $plan.pageable,
                order_by: $plan.order_by.clone(),
                order_dir: $plan.order_dir.clone(),
                rows_affected: None,
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        } else {
            let run = timeout(query_timeout($secs), async {
                if $mode.prepared() {
                    sqlx::query(sqlx::AssertSqlSafe($plan.sql.clone()))
                        .persistent(false)
                        .execute(&mut *$conn)
                        .await
                } else {
                    sqlx::raw_sql(sqlx::AssertSqlSafe($plan.sql.clone()))
                        .execute(&mut *$conn)
                        .await
                }
            });
            let res = run
                .await
                .map_err(|_| AppError::timeout("クエリ"))?
                .map_err(db_error)?;
            Ok(QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                clipped: Vec::new(),
                offset: 0,
                has_more: false,
                pageable: false,
                order_by: None,
                order_dir: None,
                rows_affected: Some(res.rows_affected()),
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        }
    }};
}

/// MySQL: SQLの結果を全件CSVへ書き出す
pub async fn export_csv_mysql<W: std::io::Write>(
    conn: &mut MySqlConnection,
    sql: &str,
    mode: SqlMode,
    out: &mut W,
    job: Option<&CsvJob>,
) -> Result<(usize, bool), AppError> {
    export_csv_impl!(conn, sql, mode, out, job, mysql_cell_full)
}

/// PostgreSQL: SQLの結果を全件CSVへ書き出す
pub async fn export_csv_pg<W: std::io::Write>(
    conn: &mut PgConnection,
    sql: &str,
    mode: SqlMode,
    out: &mut W,
    job: Option<&CsvJob>,
) -> Result<(usize, bool), AppError> {
    export_csv_impl!(conn, sql, mode, out, job, pg_cell_full)
}

/// SQLite: SQLの結果を全件CSVへ書き出す
pub async fn export_csv_sqlite<W: std::io::Write>(
    conn: &mut SqliteConnection,
    sql: &str,
    mode: SqlMode,
    out: &mut W,
    job: Option<&CsvJob>,
) -> Result<(usize, bool), AppError> {
    export_csv_impl!(conn, sql, mode, out, job, sqlite_cell_full)
}

/// MySQL: 1文を実行する
pub async fn run_mysql(
    conn: &mut MySqlConnection,
    plan: &PlannedQuery,
    mode: SqlMode,
    timeout_secs: u64,
) -> Result<QueryResult, AppError> {
    run_impl!(conn, plan, mode, timeout_secs, mysql_cell, mysql_cell_all)
}

/// PostgreSQLが「この型はバイナリ形式で送れない」と言ってきたか。
///
/// プリペアド (拡張プロトコル) では結果をバイナリ形式で受け取るが、
/// `aclitem` などバイナリの出力関数を持たない型があり、
/// `SELECT * FROM pg_class` のようなカタログの参照が失敗する。
/// メッセージが英語でない場合は見分けられないが、その場合は
/// 今までどおりエラーになるだけで、危険側には倒れない
fn pg_needs_text_format(msg: &str) -> bool {
    msg.contains("no binary output function")
}

pub async fn run_pg(
    conn: &mut PgConnection,
    plan: &PlannedQuery,
    mode: SqlMode,
    timeout_secs: u64,
) -> Result<QueryResult, AppError> {
    let res = run_pg_once(conn, plan, mode, timeout_secs).await;
    /*
     * バイナリ形式で受け取れない型が混ざっていたときだけ、テキストで送り直す。
     * この1文はこちらで分割済みなので、テキストで送っても複数文にはならない
     * (=守りは「字句解析まかせ」に一段落ちるが、読み取り専用の判定は効いている)
     */
    match res {
        Err(e)
            if matches!(mode, SqlMode::Prepared { retry_text: true })
                && pg_needs_text_format(&e.message) =>
        {
            run_pg_once(conn, plan, SqlMode::Raw, timeout_secs).await
        }
        other => other,
    }
}

/// PostgreSQL: 1文を実行する (送り方を変えてのやり直しはしない)
async fn run_pg_once(
    conn: &mut PgConnection,
    plan: &PlannedQuery,
    mode: SqlMode,
    timeout_secs: u64,
) -> Result<QueryResult, AppError> {
    run_impl!(conn, plan, mode, timeout_secs, pg_cell, pg_cell_all)
}

/// SQLite: 1文を実行する
pub async fn run_sqlite(
    conn: &mut SqliteConnection,
    plan: &PlannedQuery,
    mode: SqlMode,
    timeout_secs: u64,
) -> Result<QueryResult, AppError> {
    run_impl!(conn, plan, mode, timeout_secs, sqlite_cell, sqlite_cell_all)
}

/// テスト
#[cfg(test)]
mod tests;
