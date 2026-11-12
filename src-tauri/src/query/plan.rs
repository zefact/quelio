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

/// LIMIT/OFFSETを付けてページングできるSQLかどうか
fn is_pageable(d: Dialect, trimmed: &str) -> bool {
    !matches!(paging(d, trimmed), Paging::No)
}

/// ページングのしかた
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Paging {
    /// ページングしない (結果を返さない文・件数の指定を読み解けないもの)
    No,
    /// 件数の指定が無いので、そのまま `LIMIT 1001 OFFSET n` を足す
    Free,
    /// 利用者が外側の末尾に書いた件数の範囲の中で、1000行ずつ送る
    Within(UserLimit),
}

/// 利用者が外側の末尾に書いた件数の指定
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct UserLimit {
    /// SQLの中で `LIMIT` が始まる位置 (ここから後ろを付け替える)
    at: usize,
    /// 取り出す件数
    count: u64,
    /// 読み飛ばす件数 (`OFFSET m` / MySQLの `LIMIT m, n`)
    skip: u64,
}

/// ページングのしかたを決める。
///
/// 判定は文字列・コメントを伏せたうえで単語として見る
/// (`rate_limits` のような名前に反応せず、`'LIMIT'` という値にも釣られない)。
///
/// 見るのは括弧の外だけ。サブクエリや JOIN の中の `LIMIT` は外側の件数を絞らないので、
/// それで外すと、何百万行でも全部が送られてきてしまう
/// (先頭1000行だけ読んで止めると、残りの受け取りを次の実行が待たされる)。
///
/// 外側の末尾に `LIMIT n` (と `OFFSET m`) が書いてあれば、その範囲の中で1000行ずつ送る。
/// 読み解けない書き方 (`FETCH FIRST …`・式やパラメータの件数・後ろに句が続くもの) は
/// これまでどおりページングしない
fn paging(d: Dialect, trimmed: &str) -> Paging {
    if !is_fetch(trimmed)
        || !matches!(
            head_keyword(trimmed).as_str(),
            "SELECT" | "WITH" | "TABLE" | "VALUES"
        )
    {
        return Paging::No;
    }
    let masked = strip_literals(d, trimmed).to_ascii_uppercase();
    // FETCH FIRST … ROWS ONLY (標準SQL・PostgreSQL) もLIMITと同じ役目。
    // OFFSET だけ書いたSQLに LIMIT … OFFSET を足すと構文エラーになるので、これも見る
    let limited = ["LIMIT", "FETCH", "OFFSET"]
        .iter()
        .any(|w| has_top_level_word(&masked, w));
    if !limited {
        return Paging::Free;
    }
    user_limit(&masked, trimmed).map_or(Paging::No, Paging::Within)
}

/// 外側の末尾に書かれた `LIMIT n` / `LIMIT n OFFSET m` / `LIMIT m, n` を読み取る
fn user_limit(masked: &str, trimmed: &str) -> Option<UserLimit> {
    static TAIL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)\bLIMIT\s+(\d+)(?:\s*,\s*(\d+)|\s+OFFSET\s+(\d+))?\s*$")
            .expect("固定の正規表現")
    });
    /*
     * 伏せた形にも同じ末尾があることを確かめる。
     * 末尾の文字列やコメントの中に書かれた「LIMIT 10」は、伏せた形には残らない
     */
    let m = TAIL.captures(masked)?;
    let raw = TAIL.captures(trimmed)?;
    // 括弧の外 (サブクエリの閉じ括弧の手前などではない) であること
    let before = &masked[..m.get(0)?.start()];
    let depth = before.matches('(').count() as i64 - before.matches(')').count() as i64;
    if depth != 0 {
        return None;
    }
    let num = |i: usize| raw.get(i).and_then(|g| g.as_str().parse::<u64>().ok());
    let (count, skip) = match raw.get(2) {
        // MySQLの `LIMIT 読み飛ばす数, 件数`
        Some(_) => (num(2)?, num(1)?),
        None => (num(1)?, raw.get(3).map_or(Some(0), |_| num(3))?),
    };
    Some(UserLimit {
        at: raw.get(0)?.start(),
        count,
        skip,
    })
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

/**
 * 件数を数えるSQLを組み立てる。
 *
 * ページングで先頭だけを出しているとき、全部で何件あるかを知りたくなる。
 * 元のSQLをそのまま包むので、WHEREもJOINも書いたとおりに効く。
 * (外側に `LIMIT` を書いたSQLは、その件数で絞った結果を数える。
 * ページングしない書き方のものは数えない)
 */
pub fn plan_count(d: Dialect, sql: &str) -> Option<String> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    if !is_pageable(d, trimmed) {
        return None;
    }
    // 末尾が行コメントでも飲み込まれないよう、改行で区切って包む
    Some(format!("SELECT COUNT(*) FROM (\n{trimmed}\n) AS q"))
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
    let paging = paging(d, trimmed);

    if paging == Paging::No {
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
            sql: match paging {
                /*
                 * 書いてある件数の範囲の中で1000行ずつ送る。
                 * 末尾の LIMIT を、このページの分に付け替える
                 * (500000件まで、の指定なら、最後のページは残りの件数だけ取る)
                 */
                Paging::Within(u) => {
                    let base = trimmed[..u.at].trim_end();
                    let left = u.count.saturating_sub(offset as u64);
                    let take = left.min(PAGE_SIZE as u64 + 1);
                    format!("{base}\nLIMIT {take} OFFSET {}", u.skip + offset as u64)
                }
                // 末尾が行コメントでも飲み込まれないよう、改行してから足す
                _ => format!("{trimmed}\nLIMIT {} OFFSET {offset}", PAGE_SIZE + 1),
            },
            is_fetch: fetch,
            pageable: true,
            offset,
            order_by: None,
            order_dir: None,
            full: false,
        },
    }
}
