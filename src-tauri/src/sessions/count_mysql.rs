//! MySQLで、結果に同じ名前の列があるSQLを数えるための下調べ。
//!
//! 包んで数えるとエラーになる形かどうかは、実行せずに
//! 文の準備 (prepare) だけをして結果の列名から見分ける

use sqlx::{Column, Executor, SqlSafeStr, Statement};

use super::*;

/**
 * 列名が重なっていれば、列名を付け直して数えるSQLを返す。
 *
 * 重なっていない・準備に失敗したときは None
 * (いつもの包みで数え、失敗するならその理由をそのまま見せる)
 */
pub(super) async fn renamed_count_sql(c: &mut MySqlConnection, sql: &str) -> Option<String> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    // 列名を調べるだけで実行はしない (書いたSQLそのものを準備する)
    let safe = sqlx::AssertSqlSafe(trimmed.to_string());
    let stmt = (&mut *c).prepare(safe.into_sql_str()).await.ok()?;
    let names: Vec<&str> = stmt.columns().iter().map(|col| col.name()).collect();
    if !query::has_duplicate_names(&names) {
        return None;
    }
    query::plan_count_renamed(trimmed, names.len())
}
