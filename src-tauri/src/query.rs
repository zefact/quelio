//! 任意のSQL実行と結果セットの文字列化

use std::time::Instant;

use futures_util::{Stream, TryStreamExt};
use sqlx::mysql::{MySqlConnection, MySqlRow};
use sqlx::postgres::{PgConnection, PgRow};
use sqlx::{Column, Row};
use tokio::time::{timeout, Duration};

use crate::csv_job::CsvJob;
use crate::db::format_db_error;
use crate::export::CsvCell;
use crate::models::QueryResult;

/// SQL実行タイムアウトの既定値 (秒)。設定画面から変更できる
pub const DEFAULT_QUERY_TIMEOUT_SECS: u64 = 60;

/// SQL実行タイムアウト。0は無制限 (実装上は十分大きな値) として扱う
fn query_timeout(secs: u64) -> Duration {
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

/// セル文字列を表示用に切り詰める (切り詰めた場合は全体の文字数を添える)。
/// maxにusize::MAXを渡すと切り詰めない (CSV出力用)
fn clip_cell(s: String, max: usize) -> String {
    // 大半の値は短いので、まず安価なバイト長で判定する
    // (1文字1バイト以上なので、バイト長が上限以下なら文字数も上限以下)
    if s.len() <= max {
        return s;
    }
    let total = s.chars().count();
    if total <= max {
        return s;
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}… (全{total}文字)")
}

/// 実行計画: LIMIT自動付与の有無を決めた実行用SQL
pub struct PlannedQuery {
    /// 実際に発行するSQL
    pub sql: String,
    pub is_fetch: bool,
    pub pageable: bool,
    pub offset: usize,
    /// サーバーサイドソート中のカラムと方向
    pub order_by: Option<String>,
    pub order_dir: Option<String>,
}

/// SQLテキストをセミコロンで文単位に分割する。
/// 文字列リテラル ('...', "...", `...`)、行コメント (-- , #)、
/// ブロックコメント (/* */) 内のセミコロンは区切りとして扱わない。
pub fn split_statements(sql: &str) -> Vec<String> {
    #[derive(PartialEq)]
    enum St {
        Normal,
        Squote,
        Dquote,
        Bquote,
        LineComment,
        BlockComment,
    }

    let mut stmts = Vec::new();
    let mut cur = String::new();
    let mut st = St::Normal;
    let mut chars = sql.chars().peekable();

    while let Some(c) = chars.next() {
        match st {
            St::Normal => match c {
                '\'' => {
                    st = St::Squote;
                    cur.push(c);
                }
                '"' => {
                    st = St::Dquote;
                    cur.push(c);
                }
                '`' => {
                    st = St::Bquote;
                    cur.push(c);
                }
                '-' if chars.peek() == Some(&'-') => {
                    st = St::LineComment;
                    cur.push(c);
                }
                '#' => {
                    st = St::LineComment;
                    cur.push(c);
                }
                '/' if chars.peek() == Some(&'*') => {
                    st = St::BlockComment;
                    cur.push(c);
                }
                ';' => {
                    let t = cur.trim();
                    if !t.is_empty() {
                        stmts.push(t.to_string());
                    }
                    cur.clear();
                }
                _ => cur.push(c),
            },
            St::Squote | St::Dquote => {
                cur.push(c);
                if c == '\\' {
                    if let Some(n) = chars.next() {
                        cur.push(n);
                    }
                } else if (c == '\'' && st == St::Squote) || (c == '"' && st == St::Dquote) {
                    st = St::Normal;
                }
            }
            St::Bquote => {
                cur.push(c);
                if c == '`' {
                    st = St::Normal;
                }
            }
            St::LineComment => {
                cur.push(c);
                if c == '\n' {
                    st = St::Normal;
                }
            }
            St::BlockComment => {
                cur.push(c);
                if c == '*' && chars.peek() == Some(&'/') {
                    cur.push(chars.next().unwrap());
                    st = St::Normal;
                }
            }
        }
    }
    let t = cur.trim();
    if !t.is_empty() {
        stmts.push(t.to_string());
    }
    stmts
}

/// 先頭のコメント (行コメント -- / #、ブロックコメント /* */) と空白を読み飛ばす。
/// 「-- explain」のようなコメントで始まるSELECT文をSELECT系と判定できるようにする
fn strip_leading_comments(mut s: &str) -> &str {
    loop {
        s = s.trim_start();
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.split_once('\n').map_or("", |(_, r)| r);
        } else if let Some(rest) = s.strip_prefix('#') {
            s = rest.split_once('\n').map_or("", |(_, r)| r);
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = rest.split_once("*/").map_or("", |(_, r)| r);
        } else {
            return s;
        }
    }
}

/// SQLの先頭キーワード (コメントを除いた最初の単語) を大文字で返す
fn head_keyword(sql: &str) -> String {
    strip_leading_comments(sql)
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase()
}

/// 結果セットを返す種類のSQLかどうか
fn is_fetch(sql: &str) -> bool {
    matches!(
        head_keyword(sql).as_str(),
        "SELECT" | "SHOW" | "WITH" | "EXPLAIN" | "DESCRIBE" | "DESC" | "VALUES" | "TABLE"
    )
}

/// 識別子をDB種別に応じてクォートする
fn quote_ident(name: &str, mysql_quoting: bool) -> String {
    if mysql_quoting {
        format!("`{}`", name.replace('`', "``"))
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

/// LIMIT/OFFSETを自動付与できる (＝ページングできる) SQLかどうか
fn is_pageable(trimmed: &str) -> bool {
    is_fetch(trimmed)
        && matches!(
            head_keyword(trimmed).as_str(),
            "SELECT" | "WITH" | "TABLE" | "VALUES"
        )
        && !trimmed.to_ascii_uppercase().contains("LIMIT")
}

/// CSV出力用のSQLを組み立てる。
/// ページングのLIMITは付けずに全件を対象とし、
/// 画面でソート中ならサブクエリで包んで同じ並び順にする
pub fn plan_export(sql: &str, order: Option<(&str, &str)>, mysql_quoting: bool) -> String {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    match order {
        Some((column, dir)) if is_pageable(trimmed) => {
            let quoted = quote_ident(column, mysql_quoting);
            format!("SELECT * FROM ({trimmed}) AS q ORDER BY {quoted} {dir}")
        }
        _ => trimmed.to_string(),
    }
}

/// SQLからページング用の実行計画を作る。
/// LIMITを含まないSELECT系には `LIMIT PAGE_SIZE+1 OFFSET n` を付与し、
/// orderが指定されていればサブクエリで包んで ORDER BY を付ける (サーバーサイドソート)。
pub fn plan(
    sql: &str,
    offset: usize,
    order: Option<(&str, &str)>,
    mysql_quoting: bool,
) -> PlannedQuery {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let fetch = is_fetch(trimmed);
    let pageable = is_pageable(trimmed);

    if !pageable {
        return PlannedQuery {
            sql: trimmed.to_string(),
            is_fetch: fetch,
            pageable: false,
            offset: 0,
            order_by: None,
            order_dir: None,
        };
    }

    match order {
        Some((column, dir)) => {
            let quoted = quote_ident(column, mysql_quoting);
            PlannedQuery {
                sql: format!(
                    "SELECT * FROM ({trimmed}) AS q ORDER BY {quoted} {dir} LIMIT {} OFFSET {offset}",
                    PAGE_SIZE + 1
                ),
                is_fetch: fetch,
                pageable: true,
                offset,
                order_by: Some(column.to_string()),
                order_dir: Some(dir.to_ascii_lowercase()),
            }
        }
        None => PlannedQuery {
            sql: format!("{trimmed} LIMIT {} OFFSET {offset}", PAGE_SIZE + 1),
            is_fetch: fetch,
            pageable: true,
            offset,
            order_by: None,
            order_dir: None,
        },
    }
}

fn bytes_preview(bytes: &[u8]) -> String {
    let hex: String = bytes.iter().take(32).map(|b| format!("{b:02x}")).collect();
    if bytes.len() > 32 {
        format!("0x{hex}… ({} bytes)", bytes.len())
    } else {
        format!("0x{hex}")
    }
}

/// 1マクロで複数の型を順に試すセル文字列化。
/// `型 => 数値かどうか` の並びで書く (数値はCSVでクォートしないため)
macro_rules! try_types {
    ($row:expr, $i:expr, $max:expr, [$($t:ty => $num:expr),+ $(,)?]) => {
        $(
            if let Ok(v) = $row.try_get::<Option<$t>, _>($i) {
                return v.map(|x| CsvCell {
                    text: clip_cell(x.to_string(), $max),
                    numeric: $num,
                });
            }
        )+
    };
}

/// 画面表示用のセル値 (長すぎる値は切り詰める)
fn mysql_cell(row: &MySqlRow, i: usize) -> Option<String> {
    mysql_cell_max(row, i, MAX_CELL_CHARS).map(|c| c.text)
}

/// CSV出力用のセル値 (切り詰めず、数値かどうかも返す)
fn mysql_cell_full(row: &MySqlRow, i: usize) -> Option<CsvCell> {
    mysql_cell_max(row, i, usize::MAX)
}

fn mysql_cell_max(row: &MySqlRow, i: usize, max: usize) -> Option<CsvCell> {
    try_types!(row, i, max, [
        String => false,
        i64 => true,
        u64 => true,
        rust_decimal::Decimal => true,
        f64 => true,
        f32 => true,
        chrono::NaiveDateTime => false,
        chrono::DateTime<chrono::Utc> => false,
        chrono::NaiveDate => false,
        chrono::NaiveTime => false,
        bool => false,
        serde_json::Value => false,
    ]);
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| CsvCell::text(bytes_preview(&b)));
    }
    Some(CsvCell::text("(未対応の型)".into()))
}

/// 画面表示用のセル値 (長すぎる値は切り詰める)
fn pg_cell(row: &PgRow, i: usize) -> Option<String> {
    pg_cell_max(row, i, MAX_CELL_CHARS).map(|c| c.text)
}

/// CSV出力用のセル値 (切り詰めず、数値かどうかも返す)
fn pg_cell_full(row: &PgRow, i: usize) -> Option<CsvCell> {
    pg_cell_max(row, i, usize::MAX)
}

fn pg_cell_max(row: &PgRow, i: usize, max: usize) -> Option<CsvCell> {
    try_types!(row, i, max, [
        String => false,
        i64 => true,
        i32 => true,
        i16 => true,
        rust_decimal::Decimal => true,
        f64 => true,
        f32 => true,
        bool => false,
        chrono::NaiveDateTime => false,
        chrono::DateTime<chrono::Utc> => false,
        chrono::NaiveDate => false,
        chrono::NaiveTime => false,
        uuid::Uuid => false,
        serde_json::Value => false,
    ]);
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| CsvCell::text(bytes_preview(&b)));
    }
    Some(CsvCell::text("(未対応の型)".into()))
}

/// 結果セットのストリームから1ページ分 (PAGE_SIZE行) だけ読み取る。
///
/// PAGE_SIZE+1行目が届いた時点で読み取りを打ち切ってストリームを閉じるため、
/// LIMITを付けられないSQL (LIMIT指定済み・SHOW等) で結果が何百万行あっても、
/// アプリが保持する行数は常に1ページ分に収まる。
/// 戻り値は (カラム名, 行データ, 次ページの有無)
async fn fetch_page<R, S>(
    mut stream: S,
    cell: fn(&R, usize) -> Option<String>,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>, bool), String>
where
    R: Row,
    S: Stream<Item = Result<R, sqlx::Error>> + Unpin,
{
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut has_more = false;
    while let Some(row) = stream.try_next().await.map_err(format_db_error)? {
        if columns.is_empty() {
            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
        }
        if rows.len() >= PAGE_SIZE {
            // 次のページがあることが分かれば十分なので、ここで読み取りをやめる
            has_more = true;
            break;
        }
        rows.push((0..row.columns().len()).map(|i| cell(&row, i)).collect());
    }
    Ok((columns, rows, has_more))
}

/// 結果セットのストリームをCSVとして書き出す。
/// 1行ずつ書き出すので、何百万行でもメモリ使用量は一定。
/// 戻り値は (書き出した行数, キャンセルされたか)
async fn write_csv<R, S, W>(
    mut stream: S,
    cell: fn(&R, usize) -> Option<CsvCell>,
    out: &mut W,
    job: Option<&CsvJob>,
) -> Result<(usize, bool), String>
where
    R: Row,
    S: Stream<Item = Result<R, sqlx::Error>> + Unpin,
    W: std::io::Write,
{
    let mut count = 0usize;
    let mut wrote_header = false;
    while let Some(row) = stream.try_next().await.map_err(format_db_error)? {
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

/// MySQL: SQLの結果を全件CSVへ書き出す
pub async fn export_csv_mysql<W: std::io::Write>(
    conn: &mut MySqlConnection,
    sql: &str,
    out: &mut W,
    job: Option<&CsvJob>,
) -> Result<(usize, bool), String> {
    let stream = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string())).fetch(&mut *conn);
    write_csv(stream, mysql_cell_full, out, job).await
}

/// PostgreSQL: SQLの結果を全件CSVへ書き出す
pub async fn export_csv_pg<W: std::io::Write>(
    conn: &mut PgConnection,
    sql: &str,
    out: &mut W,
    job: Option<&CsvJob>,
) -> Result<(usize, bool), String> {
    let stream = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string())).fetch(&mut *conn);
    write_csv(stream, pg_cell_full, out, job).await
}

pub async fn run_mysql(
    conn: &mut MySqlConnection,
    plan: &PlannedQuery,
    timeout_secs: u64,
) -> Result<QueryResult, String> {
    let started = Instant::now();
    if plan.is_fetch {
        let (columns, data, has_more) = timeout(
            query_timeout(timeout_secs),
            fetch_page(
                sqlx::raw_sql(sqlx::AssertSqlSafe(plan.sql.clone())).fetch(&mut *conn),
                mysql_cell,
            ),
        )
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())??;

        Ok(QueryResult {
            columns,
            rows: data,
            offset: plan.offset,
            has_more,
            pageable: plan.pageable,
            order_by: plan.order_by.clone(),
            order_dir: plan.order_dir.clone(),
            rows_affected: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    } else {
        let res = timeout(
            query_timeout(timeout_secs),
            sqlx::raw_sql(sqlx::AssertSqlSafe(plan.sql.clone())).execute(&mut *conn),
        )
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            offset: 0,
            has_more: false,
            pageable: false,
            order_by: None,
            order_dir: None,
            rows_affected: Some(res.rows_affected()),
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }
}

pub async fn run_pg(
    conn: &mut PgConnection,
    plan: &PlannedQuery,
    timeout_secs: u64,
) -> Result<QueryResult, String> {
    let started = Instant::now();
    if plan.is_fetch {
        let (columns, data, has_more) = timeout(
            query_timeout(timeout_secs),
            fetch_page(
                sqlx::raw_sql(sqlx::AssertSqlSafe(plan.sql.clone())).fetch(&mut *conn),
                pg_cell,
            ),
        )
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())??;

        Ok(QueryResult {
            columns,
            rows: data,
            offset: plan.offset,
            has_more,
            pageable: plan.pageable,
            order_by: plan.order_by.clone(),
            order_dir: plan.order_dir.clone(),
            rows_affected: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    } else {
        let res = timeout(
            query_timeout(timeout_secs),
            sqlx::raw_sql(sqlx::AssertSqlSafe(plan.sql.clone())).execute(&mut *conn),
        )
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            offset: 0,
            has_more: false,
            pageable: false,
            order_by: None,
            order_dir: None,
            rows_affected: Some(res.rows_affected()),
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }
}
