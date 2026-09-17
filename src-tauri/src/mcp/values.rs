//! 列の値の分布 (`column_values`)。
//!
//! 「`status` に何が入っているか」が分からないと、AIは推測でSQLを書く。
//! 種類と件数を見せておくと、文字列の書き分け (`"done"` か `"DONE"` か) で
//! 外すことが減る。
//!
//! SQLは自分で組み立てるので `catalog.rs` とは分けてある
//! (あちらは「既存の処理を呼んで写すだけ」の場所)。
//! 組み立てにはDDLと同じクォート関数を使い、名前を文字列連結で埋めない

use tauri::AppHandle;

use crate::ddl;
use crate::models::DbType;

use super::rows::RowFormat;
use super::session::Opened;
use super::views::{AiColumnValue, AiColumnValues};
use super::{catalog, query};

/// 既定で返す種類の数
const DEFAULT_LIMIT: usize = 50;

/// 返す種類の数の上限 (AIの入力を埋めないため)
const MAX_LIMIT: usize = 200;

/// 上限を丸める (指定なし・0・大きすぎる値をそろえる)
fn clamp_limit(limit: Option<usize>) -> usize {
    match limit {
        None | Some(0) => DEFAULT_LIMIT,
        Some(n) => n.min(MAX_LIMIT),
    }
}

/// 列が無いときの文言
fn no_such_column(table: &str, column: &str) -> String {
    format!("{table} に {column} という列はありません")
}

/// 値の分布を数えるSQLを組み立てる。
///
/// 打ち切りを見分けるため、欲しい数より1つ多く取る。
/// 並びは件数の多い順。同じ件数のときは値順にして、
/// 呼ぶたびに入れ替わらないようにする
fn values_sql(
    db: DbType,
    schema: Option<&str>,
    table: &str,
    column: &str,
    limit: usize,
) -> String {
    let col = ddl::quote(db, column);
    format!(
        "SELECT {col}, COUNT(*) FROM {table} GROUP BY {col} ORDER BY COUNT(*) DESC, {col} LIMIT {n}",
        table = ddl::quote_table(db, schema, table),
        n = limit + 1,
    )
}

/// 返ってきた行を、AI向けの形にまとめる。
///
/// NULL は別枠にする (値の一覧に混ぜると、文字列の "NULL" と区別できない)
fn summarize(
    column: String,
    cells: Vec<Vec<Option<String>>>,
    limit: usize,
) -> AiColumnValues {
    // 1つ多く頼んでいるので、その数だけ返ってきたら「ほかにもある」
    let truncated = cells.len() > limit;
    let mut values = Vec::new();
    let mut null_count = None;
    for row in cells {
        let count = row
            .get(1)
            .and_then(|c| c.as_deref())
            .and_then(|c| c.parse::<i64>().ok())
            .unwrap_or(0);
        match row.first().and_then(|c| c.clone()) {
            Some(v) => values.push(AiColumnValue { value: v, count }),
            None => null_count = Some(count),
        }
    }

    values.truncate(limit);
    let distinct_at_least = values.len() + usize::from(null_count.is_some());

    // 打ち切ったうえに NULL が出てこなかった場合は「0件」と言えない
    if truncated && null_count.is_none() {
        return AiColumnValues {
            column,
            values,
            null_count: None,
            truncated,
            distinct_at_least,
        };
    }
    AiColumnValues {
        column,
        values,
        null_count: Some(null_count.unwrap_or(0)),
        truncated,
        distinct_at_least,
    }
}

/// 列の値の分布を返す
pub async fn column_values(
    app: &AppHandle,
    opened: &Opened,
    database: Option<String>,
    table: &str,
    column: &str,
    limit: Option<usize>,
) -> Result<AiColumnValues, String> {
    // まず列があることを確かめる。
    // 無い名前でSQLを流すと、DBのエラー文がそのままAIへ返ってしまう
    let detail = catalog::describe_table(app, opened, database.clone(), table).await?;
    let found = detail
        .columns
        .iter()
        .find(|c| c.name == column)
        // 大文字小文字の違いは拾う (AIは定義を見ずに打つことがある)
        .or_else(|| {
            detail
                .columns
                .iter()
                .find(|c| c.name.eq_ignore_ascii_case(column))
        })
        .ok_or_else(|| no_such_column(&detail.table, column))?;

    let (schema, name) = catalog::split_qualified(table);
    let limit = clamp_limit(limit);
    let sql = values_sql(
        opened.db_type,
        schema.as_deref(),
        &name,
        // 実際の綴りで組み立てる (AIが送ってきた綴りは使わない)
        &found.name,
        limit,
    );

    // 既存の読み取り経路に乗せる (公開レベルの確認・`[AI]` の記録もそのまま)
    let rows = query::run(
        app,
        opened,
        database,
        &sql,
        Some(limit + 1),
        RowFormat::Json,
    )
    .await?;

    Ok(summarize(
        found.name.clone(),
        rows.rows.unwrap_or_default(),
        limit,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 上限は既定と最大に収める() {
        assert_eq!(clamp_limit(None), DEFAULT_LIMIT);
        // 0件を頼まれても意味が無いので既定に戻す
        assert_eq!(clamp_limit(Some(0)), DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(10)), 10);
        assert_eq!(clamp_limit(Some(10_000)), MAX_LIMIT);
    }

    #[test]
    fn mysqlはバッククォートで組み立てる() {
        let got = values_sql(DbType::Mysql, None, "users", "status", 50);
        assert_eq!(
            got,
            "SELECT `status`, COUNT(*) FROM `users` \
GROUP BY `status` ORDER BY COUNT(*) DESC, `status` LIMIT 51"
        );
    }

    #[test]
    fn スキーマ付きは二重引用符で組み立てる() {
        let got = values_sql(DbType::Postgresql, Some("public"), "users", "kind", 2);
        assert!(got.contains("FROM \"public\".\"users\""), "{got}");
        assert!(got.ends_with("LIMIT 3"), "{got}");
    }

    #[test]
    fn 名前の引用符は逃がす() {
        // 連結で組み立てていないことの確認
        let got = values_sql(DbType::Mysql, None, "a`b", "c`d", 1);
        assert!(got.contains("`a``b`"), "{got}");
        assert!(got.contains("`c``d`"), "{got}");
    }

    fn cell(v: Option<&str>, n: &str) -> Vec<Option<String>> {
        vec![v.map(|s| s.to_string()), Some(n.to_string())]
    }

    #[test]
    fn nullは別枠にする() {
        let got = summarize(
            "status".into(),
            vec![cell(Some("done"), "10"), cell(None, "3")],
            50,
        );
        assert_eq!(
            got.values,
            vec![AiColumnValue {
                value: "done".into(),
                count: 10
            }]
        );
        assert_eq!(got.null_count, Some(3));
        assert!(!got.truncated);
        // 値1種類 + NULL
        assert_eq!(got.distinct_at_least, 2);
    }

    #[test]
    fn nullが無ければ0件と返す() {
        let got = summarize("status".into(), vec![cell(Some("done"), "1")], 50);
        assert_eq!(got.null_count, Some(0));
        assert_eq!(got.distinct_at_least, 1);
    }

    #[test]
    fn あふれたぶんは返さず印を立てる() {
        let cells = vec![cell(Some("a"), "3"), cell(Some("b"), "2"), cell(Some("c"), "1")];
        let got = summarize("k".into(), cells, 2);
        assert_eq!(got.values.len(), 2);
        assert!(got.truncated);
        // 打ち切ったうえに NULL を見ていないので「0件」とは言わない
        assert_eq!(got.null_count, None);
        assert_eq!(got.distinct_at_least, 2);
    }

    #[test]
    fn 打ち切ってもnullを見ていれば件数を返す() {
        let cells = vec![cell(None, "9"), cell(Some("a"), "3"), cell(Some("b"), "2")];
        let got = summarize("k".into(), cells, 1);
        assert_eq!(got.null_count, Some(9));
        assert!(got.truncated);
    }

    #[test]
    fn 列が無いときの文言() {
        assert_eq!(
            no_such_column("users", "stat"),
            "users に stat という列はありません"
        );
    }
}
