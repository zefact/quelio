//! 任意のSQL実行と結果セットの文字列化

use std::time::Instant;

use sqlx::mysql::{MySqlConnection, MySqlRow};
use sqlx::postgres::{PgConnection, PgRow};
use sqlx::{Column, Row};
use tokio::time::{timeout, Duration};

use crate::db::format_db_error;
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
    let head = head_keyword(trimmed);
    let pageable = fetch
        && matches!(head.as_str(), "SELECT" | "WITH" | "TABLE" | "VALUES")
        && !trimmed.to_ascii_uppercase().contains("LIMIT");

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
            let quoted = if mysql_quoting {
                format!("`{}`", column.replace('`', "``"))
            } else {
                format!("\"{}\"", column.replace('"', "\"\""))
            };
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

/// 1マクロで複数の型を順に試すセル文字列化
macro_rules! try_types {
    ($row:expr, $i:expr, [$($t:ty),+ $(,)?]) => {
        $(
            if let Ok(v) = $row.try_get::<Option<$t>, _>($i) {
                return v.map(|x| x.to_string());
            }
        )+
    };
}

fn mysql_cell(row: &MySqlRow, i: usize) -> Option<String> {
    try_types!(row, i, [
        String,
        i64,
        u64,
        rust_decimal::Decimal,
        f64,
        f32,
        chrono::NaiveDateTime,
        chrono::DateTime<chrono::Utc>,
        chrono::NaiveDate,
        chrono::NaiveTime,
        bool,
        serde_json::Value,
    ]);
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| bytes_preview(&b));
    }
    Some("(未対応の型)".into())
}

fn pg_cell(row: &PgRow, i: usize) -> Option<String> {
    try_types!(row, i, [
        String,
        i64,
        i32,
        i16,
        rust_decimal::Decimal,
        f64,
        f32,
        bool,
        chrono::NaiveDateTime,
        chrono::DateTime<chrono::Utc>,
        chrono::NaiveDate,
        chrono::NaiveTime,
        uuid::Uuid,
        serde_json::Value,
    ]);
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| bytes_preview(&b));
    }
    Some("(未対応の型)".into())
}

pub async fn run_mysql(
    conn: &mut MySqlConnection,
    plan: &PlannedQuery,
    timeout_secs: u64,
) -> Result<QueryResult, String> {
    let started = Instant::now();
    if plan.is_fetch {
        let rows = timeout(
            query_timeout(timeout_secs),
            sqlx::raw_sql(sqlx::AssertSqlSafe(plan.sql.clone())).fetch_all(&mut *conn),
        )
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;

        let columns = rows
            .first()
            .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
            .unwrap_or_default();
        let has_more = rows.len() > PAGE_SIZE;
        let data = rows
            .iter()
            .take(PAGE_SIZE)
            .map(|r| (0..r.columns().len()).map(|i| mysql_cell(r, i)).collect())
            .collect();
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
        let rows = timeout(
            query_timeout(timeout_secs),
            sqlx::raw_sql(sqlx::AssertSqlSafe(plan.sql.clone())).fetch_all(&mut *conn),
        )
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;

        let columns = rows
            .first()
            .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
            .unwrap_or_default();
        let has_more = rows.len() > PAGE_SIZE;
        let data = rows
            .iter()
            .take(PAGE_SIZE)
            .map(|r| (0..r.columns().len()).map(|i| pg_cell(r, i)).collect())
            .collect();
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
