//! 結果に同じ名前の列があるSQLの数え方。
//!
//! 件数は元のSQLを `SELECT COUNT(*) FROM (...) AS q` で包んで数えるが、
//! MySQLは FROM の中の副問い合わせに同じ名前の列があるとエラー (1060) にする
//! (`SELECT a.id, b.id FROM a JOIN b ...` のようなよくある形でも起きる)。
//! そのときは列名を付け直したCTEで包んで数える

/**
 * 列名に重なりがあるか。
 *
 * MySQLの列名は大文字小文字を区別しないので、区別せずに比べる
 */
pub fn has_duplicate_names(names: &[&str]) -> bool {
    let mut seen = std::collections::HashSet::new();
    names.iter().any(|n| !seen.insert(n.to_lowercase()))
}

/**
 * 列名を付け直して数えるSQL。
 *
 * `WITH q(c1, c2, …) AS (元のSQL) SELECT COUNT(*) FROM q` の形にする。
 * 元のSQLが `WITH` で始まっていても、CTEの中に書けるのでそのまま包める
 */
pub fn plan_count_renamed(sql: &str, columns: usize) -> Option<String> {
    if columns == 0 {
        return None;
    }
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let names: Vec<String> = (1..=columns).map(|i| format!("c{i}")).collect();
    // 末尾が行コメントでも飲み込まれないよう、改行で区切って包む
    Some(format!(
        "WITH q({}) AS (\n{trimmed}\n) SELECT COUNT(*) FROM q",
        names.join(", ")
    ))
}
