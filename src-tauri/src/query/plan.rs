//! 実行するSQLの組み立て (ページングのLIMIT付与とCSV出力用)

use super::*;

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
    /// trueなら値の切り詰めも行数の打ち切りもしない。
    /// EXPLAIN の実行計画は1セルに長い木が入るため、途中で切れると読めなくなる
    pub full: bool,
}

/// 識別子をDB種別に応じてクォートする
fn quote_ident(name: &str, mysql_quoting: bool) -> String {
    if mysql_quoting {
        format!("`{}`", name.replace('`', "``"))
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

/// LIMIT/OFFSETを自動付与できる (＝ページングできる) SQLかどうか。
///
/// 件数を絞る書き方が既にあるSQLには足さない。
/// 判定は文字列・コメントを伏せたうえで単語として見る
/// (`rate_limits` のような名前に反応せず、`'LIMIT'` という値にも釣られない)
fn is_pageable(d: Dialect, trimmed: &str) -> bool {
    if !is_fetch(trimmed)
        || !matches!(
            head_keyword(trimmed).as_str(),
            "SELECT" | "WITH" | "TABLE" | "VALUES"
        )
    {
        return false;
    }
    let masked = strip_literals(d, trimmed).to_ascii_uppercase();
    // FETCH FIRST … ROWS ONLY (標準SQL・PostgreSQL) もLIMITと同じ役目
    !contains_word(&masked, "LIMIT") && !contains_word(&masked, "FETCH")
}

/// 元のSQLをサブクエリとして包む。
///
/// 末尾が行コメント (`-- メモ`) で終わっていると、
/// 同じ行に足したものがすべてコメントに飲み込まれるため、必ず改行で区切る
fn wrap_sub(trimmed: &str) -> String {
    format!("SELECT * FROM (\n{trimmed}\n) AS q")
}

/// CSV出力用のSQLを組み立てる。
/// ページングのLIMITは付けずに全件を対象とし、
/// 画面でソート中ならサブクエリで包んで同じ並び順にする
pub fn plan_export(
    d: Dialect,
    sql: &str,
    order: Option<(&str, &str)>,
    mysql_quoting: bool,
) -> String {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    match order {
        Some((column, dir)) if is_pageable(d, trimmed) => {
            let quoted = quote_ident(column, mysql_quoting);
            format!("{} ORDER BY {quoted} {dir}", wrap_sub(trimmed))
        }
        _ => trimmed.to_string(),
    }
}

/// SQLからページング用の実行計画を作る。
/// LIMITを含まないSELECT系には `LIMIT PAGE_SIZE+1 OFFSET n` を付与し、
/// orderが指定されていればサブクエリで包んで ORDER BY を付ける (サーバーサイドソート)。
pub fn plan(
    d: Dialect,
    sql: &str,
    offset: usize,
    order: Option<(&str, &str)>,
    mysql_quoting: bool,
) -> PlannedQuery {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let fetch = is_fetch(trimmed);
    let pageable = is_pageable(d, trimmed);

    if !pageable {
        return PlannedQuery {
            sql: trimmed.to_string(),
            is_fetch: fetch,
            pageable: false,
            offset: 0,
            order_by: None,
            order_dir: None,
            full: false,
        };
    }

    match order {
        Some((column, dir)) => {
            let quoted = quote_ident(column, mysql_quoting);
            PlannedQuery {
                sql: format!(
                    "{} ORDER BY {quoted} {dir} LIMIT {} OFFSET {offset}",
                    wrap_sub(trimmed),
                    PAGE_SIZE + 1
                ),
                is_fetch: fetch,
                pageable: true,
                offset,
                order_by: Some(column.to_string()),
                order_dir: Some(dir.to_ascii_lowercase()),
                full: false,
            }
        }
        None => PlannedQuery {
            // 末尾が行コメントでも飲み込まれないよう、改行してから足す
            sql: format!("{trimmed}\nLIMIT {} OFFSET {offset}", PAGE_SIZE + 1),
            is_fetch: fetch,
            pageable: true,
            offset,
            order_by: None,
            order_dir: None,
            full: false,
        },
    }
}
