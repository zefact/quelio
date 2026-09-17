//! 一覧・定義の参照ツールの中身。
//!
//! どれも既存の `sessions::*` を呼んで、返ってきた画面用の型を
//! AI向けの素直な形へ写すだけ。DBを触る処理はここに書かない。
//!
//! 画面用の型をそのまま返さないのは、表示のための項目
//! (切り詰めの位置・パーティションの定義など) が混ざっていて、
//! AIにとっては雑音にしかならないため

use tauri::{AppHandle, Manager};

use crate::export::parse_comment;
use crate::models::{DbType, TableInfo};

use super::session::Opened;
use super::views::{
    AiColumn, AiDatabases, AiForeignKey, AiHit, AiIndex, AiSearchResult, AiTable, AiTableDetail,
    AiTables,
};

/// 検索で返す上限 (AIの入力に収まる量に留める)
const SEARCH_LIMIT: usize = 100;

/// 使うデータベース名を決める。
///
/// 指定が無ければプロファイルの既定DB。
/// SQLiteはファイル1つなので、何を渡されても空にする
pub fn database_of(opened: &Opened, requested: Option<String>) -> String {
    if opened.db_type == DbType::Sqlite {
        return String::new();
    }
    requested
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| opened.default_db.clone())
}

/// つながっているサーバーのデータベース一覧
pub async fn list_databases(app: &AppHandle, opened: &Opened) -> Result<AiDatabases, String> {
    let sessions = app.state::<crate::sessions::Sessions>();
    let qlog = app.state::<crate::query_log::QueryLog>();
    let databases =
        crate::sessions::list_databases(&sessions, &qlog, &opened.session_id).await?;
    Ok(AiDatabases { databases })
}

/// テーブル・ビューの一覧 (日本語名つき)
pub async fn list_tables(
    app: &AppHandle,
    opened: &Opened,
    database: Option<String>,
) -> Result<AiTables, String> {
    let sessions = app.state::<crate::sessions::Sessions>();
    let qlog = app.state::<crate::query_log::QueryLog>();
    let db = database_of(opened, database);
    let list = crate::sessions::list_tables(&sessions, &qlog, &opened.session_id, &db).await?;
    // 論理名の分け方は利用者の設定に従う (画面と同じ見え方にする)
    let delim = comment_delimiter(app);
    Ok(AiTables {
        tables: list.iter().map(|t| to_ai_table(t, &delim)).collect(),
    })
}

/// 論理名を分ける区切り文字 (読めなければ既定)
fn comment_delimiter(app: &AppHandle) -> String {
    crate::app_settings::load(app)
        .map(|s| s.comment_delimiter)
        .unwrap_or_else(|_| "（".to_string())
}

/// 画面用のテーブル情報を、AI向けの形へ写す
fn to_ai_table(t: &TableInfo, delim: &str) -> AiTable {
    AiTable {
        schema: t.schema.clone(),
        name: t.name.clone(),
        label: some_if_filled(parse_comment(t.comment.as_deref().unwrap_or(""), delim).0),
        kind: if t.table_type.to_uppercase().contains("VIEW") {
            "view"
        } else {
            "table"
        }
        .to_string(),
        row_estimate: t.row_estimate,
    }
}

/// テーブルの定義 (カラム・インデックス・外部キー)
pub async fn describe_table(
    app: &AppHandle,
    opened: &Opened,
    database: Option<String>,
    table: &str,
) -> Result<AiTableDetail, String> {
    let sessions = app.state::<crate::sessions::Sessions>();
    let qlog = app.state::<crate::query_log::QueryLog>();
    let db = database_of(opened, database);
    // "schema.table" の形も受けられるようにする (PostgreSQLで自然な書き方のため)
    let (schema, name) = split_qualified(table);
    let detail =
        crate::sessions::table_detail(&sessions, &qlog, &opened.session_id, &db, schema, &name)
            .await?;

    let delim = comment_delimiter(app);

    let table_comment = detail
        .info
        .iter()
        .find(|(label, _)| label == "コメント")
        .map(|(_, v)| v.clone())
        .unwrap_or_default();

    Ok(AiTableDetail {
        table: name,
        label: some_if_filled(parse_comment(&table_comment, &delim).0),
        columns: detail
            .columns
            .iter()
            .map(|c| {
                let (logical, note) =
                    parse_comment(c.comment.as_deref().unwrap_or(""), &delim);
                AiColumn {
                    name: c.name.clone(),
                    data_type: c.col_type.clone(),
                    nullable: c.nullable,
                    default: c.default.clone(),
                    label: some_if_filled(logical),
                    note: some_if_filled(note),
                    primary_key: c.key.as_deref() == Some("PRI"),
                }
            })
            .collect(),
        indexes: detail
            .indexes
            .iter()
            .map(|i| AiIndex {
                name: i.name.clone(),
                unique: i.unique,
                columns: i.columns.clone(),
            })
            .collect(),
        foreign_keys: detail
            .foreign_keys
            .iter()
            .map(|f| AiForeignKey {
                name: f.name.clone(),
                columns: f.columns.clone(),
                ref_table: if f.ref_schema.is_empty() {
                    f.ref_table.clone()
                } else {
                    format!("{}.{}", f.ref_schema, f.ref_table)
                },
                ref_columns: f.ref_columns.clone(),
            })
            .collect(),
    })
}

/// 名前で探す (テーブル名・カラム名・コメント)
pub async fn search_schema(
    app: &AppHandle,
    opened: &Opened,
    database: Option<String>,
    keyword: &str,
) -> Result<AiSearchResult, String> {
    let sessions = app.state::<crate::sessions::Sessions>();
    let qlog = app.state::<crate::query_log::QueryLog>();
    let db = database_of(opened, database);
    let found = crate::sessions::search_objects(
        &sessions,
        &qlog,
        &opened.session_id,
        // SQLiteは対象DBを持たないので None のまま渡す
        (!db.is_empty()).then_some(db),
        keyword,
    )
    .await?;

    // 上限を超えた分は渡さない (AIの入力を埋めるだけで役に立たない)
    let truncated = found.truncated || found.hits.len() > SEARCH_LIMIT;
    Ok(AiSearchResult {
        hits: found
            .hits
            .iter()
            .take(SEARCH_LIMIT)
            .map(|h| AiHit {
                database: h.database.clone(),
                schema: h.schema.clone(),
                table: h.table.clone(),
                column: h.column.clone(),
                data_type: h.data_type.clone(),
                comment: h.comment.clone(),
            })
            .collect(),
        truncated,
    })
}

/// 空文字は「無い」として null にする (AIに空文字を読ませない)
fn some_if_filled(s: String) -> Option<String> {
    (!s.is_empty()).then_some(s)
}

/// `schema.table` を分ける (点が無ければスキーマ指定なし)
pub(super) fn split_qualified(table: &str) -> (Option<String>, String) {
    match table.split_once('.') {
        Some((s, t)) if !s.is_empty() && !t.is_empty() => {
            (Some(s.to_string()), t.to_string())
        }
        _ => (None, table.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AiAccess;

    fn opened(db_type: DbType, default_db: &str) -> Opened {
        Opened {
            session_id: "mcp:x".to_string(),
            name: "開発DB".to_string(),
            label: "[AI] 開発DB".to_string(),
            env: Some("dev".to_string()),
            default_db: default_db.to_string(),
            db_type,
            access: AiAccess::Read,
        }
    }

    #[test]
    fn 指定が無ければ既定のデータベースを使う() {
        let o = opened(DbType::Mysql, "appdb");
        assert_eq!(database_of(&o, None), "appdb");
        assert_eq!(database_of(&o, Some("  ".into())), "appdb");
        assert_eq!(database_of(&o, Some("other".into())), "other");
    }

    #[test]
    fn sqliteはデータベース名を持たない() {
        // ファイル1つなので、何を渡されても空にする
        let o = opened(DbType::Sqlite, "/tmp/a.db");
        assert_eq!(database_of(&o, None), "");
        assert_eq!(database_of(&o, Some("main".into())), "");
    }

    #[test]
    fn スキーマ付きのテーブル名を分ける() {
        assert_eq!(
            split_qualified("public.users"),
            (Some("public".to_string()), "users".to_string())
        );
        assert_eq!(split_qualified("users"), (None, "users".to_string()));
        // 形が崩れているものは、そのままテーブル名として扱う (勝手に切らない)
        assert_eq!(split_qualified(".users"), (None, ".users".to_string()));
        assert_eq!(split_qualified("users."), (None, "users.".to_string()));
    }

    #[test]
    fn ビューと表を見分ける() {
        let t = |ty: &str| TableInfo {
            schema: None,
            name: "t".into(),
            table_type: ty.into(),
            row_estimate: Some(3),
            comment: None,
            partition_by: None,
            partition_of: None,
        };
        assert_eq!(to_ai_table(&t("BASE TABLE"), "（").kind, "table");
        assert_eq!(to_ai_table(&t("VIEW"), "（").kind, "view");
        assert_eq!(to_ai_table(&t("view"), "（").kind, "view");
    }

    #[test]
    fn 一覧にもテーブルの日本語名を入れる() {
        let t = TableInfo {
            schema: None,
            name: "orders".into(),
            table_type: "BASE TABLE".into(),
            row_estimate: None,
            comment: Some("受注（明細は order_items）".into()),
            partition_by: None,
            partition_of: None,
        };
        // 補足は落として論理名だけにする (一覧は短く読めた方がよい)
        assert_eq!(to_ai_table(&t, "（").label, Some("受注".to_string()));
    }

    #[test]
    fn コメントが無ければ日本語名はnull() {
        let t = TableInfo {
            schema: None,
            name: "orders".into(),
            table_type: "BASE TABLE".into(),
            row_estimate: None,
            comment: None,
            partition_by: None,
            partition_of: None,
        };
        assert_eq!(to_ai_table(&t, "（").label, None);
    }

    #[test]
    fn 空のコメントはnullにする() {
        assert_eq!(some_if_filled(String::new()), None);
        assert_eq!(some_if_filled("利用者".into()), Some("利用者".into()));
    }
}
