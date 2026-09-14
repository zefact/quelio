//! DB横断の名前の検索。
//!
//! テーブル名・カラム名・コメントを、カタログから探す

use serde::Serialize;
use sqlx::mysql::MySqlConnection;
use sqlx::postgres::PgConnection;
use sqlx::sqlite::SqliteConnection;
use sqlx::Row;
use tokio::time::{timeout, Duration};

use crate::apperr::AppError;
use crate::catalog::LogCtx;
use crate::db::db_error;

/// 1つの問い合わせを待つ上限
const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);

/// オブジェクト名の検索で返す最大件数
const OBJECT_LIMIT: i64 = 2000;

/// LIKEのエスケープ文字。
/// バックスラッシュはDBや設定で扱いが変わるので、紛れの無い記号を使う
const LIKE_ESCAPE: char = '!';

/// 探す文字列を LIKE のパターン (`%...%`) にする
pub fn like_pattern(needle: &str) -> String {
    let mut out = String::with_capacity(needle.len() + 2);
    out.push('%');
    for c in needle.chars() {
        if c == LIKE_ESCAPE || c == '%' || c == '_' {
            out.push(LIKE_ESCAPE);
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// 見つかったオブジェクト
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectHit {
    /// データベース名 (SQLiteは空)
    pub database: String,
    /// PostgreSQLのスキーマ (他は空)
    pub schema: String,
    pub table: String,
    /// カラム名 (テーブル自体が一致したときは空)
    pub column: String,
    pub data_type: String,
    pub comment: String,
}

/// 名前検索の結果
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectSearchResult {
    pub hits: Vec<ObjectHit>,
    /// 上限に達して打ち切った
    pub truncated: bool,
}

// ---------- オブジェクト名の検索 ----------

/// MySQL: つながっているサーバーの全データベースから探す
/// 名前検索の対象データベースを決める。
///
/// 探す範囲は画面で選んでいるデータベースの中だけにするので、
/// 選んでいなければ「何を探すか」が決まらない。
/// 黙って全体を探すと、画面に出ている範囲と食い違う
pub fn search_scope(database: Option<&str>) -> Result<&str, AppError> {
    match database.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => Ok(d),
        None => Err("データベースを選んでから検索してください".into()),
    }
}

pub async fn mysql_objects(
    conn: &mut MySqlConnection,
    database: &str,
    needle: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<ObjectHit>, AppError> {
    let pattern = like_pattern(needle);
    let mut out = Vec::new();

    let tables_sql = format!(
        "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, COALESCE(TABLE_COMMENT, '') AS CMT \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? \
           AND (TABLE_NAME LIKE ? ESCAPE '{LIKE_ESCAPE}' \
                OR COALESCE(TABLE_COMMENT, '') LIKE ? ESCAPE '{LIKE_ESCAPE}') \
         ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT {OBJECT_LIMIT}"
    );
    ctx.qlog.add(ctx.connection, ctx.database, &tables_sql);
    let rows = timeout(
        SEARCH_TIMEOUT,
        sqlx::query(sqlx::AssertSqlSafe(tables_sql.clone()))
            .bind(database)
            .bind(&pattern)
            .bind(&pattern)
            .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| AppError::timeout("検索"))?
    .map_err(db_error)?;
    for r in &rows {
        out.push(ObjectHit {
            database: r.try_get("TABLE_SCHEMA").unwrap_or_default(),
            schema: String::new(),
            table: r.try_get("TABLE_NAME").unwrap_or_default(),
            column: String::new(),
            data_type: r.try_get("TABLE_TYPE").unwrap_or_default(),
            comment: r.try_get("CMT").unwrap_or_default(),
        });
    }

    let cols_sql = format!(
        "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, \
                COALESCE(COLUMN_COMMENT, '') AS CMT \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? \
           AND (COLUMN_NAME LIKE ? ESCAPE '{LIKE_ESCAPE}' \
                OR COALESCE(COLUMN_COMMENT, '') LIKE ? ESCAPE '{LIKE_ESCAPE}') \
         ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION LIMIT {OBJECT_LIMIT}"
    );
    ctx.qlog.add(ctx.connection, ctx.database, &cols_sql);
    let rows = timeout(
        SEARCH_TIMEOUT,
        sqlx::query(sqlx::AssertSqlSafe(cols_sql.clone()))
            .bind(database)
            .bind(&pattern)
            .bind(&pattern)
            .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| AppError::timeout("検索"))?
    .map_err(db_error)?;
    for r in &rows {
        out.push(ObjectHit {
            database: r.try_get("TABLE_SCHEMA").unwrap_or_default(),
            schema: String::new(),
            table: r.try_get("TABLE_NAME").unwrap_or_default(),
            column: r.try_get("COLUMN_NAME").unwrap_or_default(),
            data_type: r.try_get("COLUMN_TYPE").unwrap_or_default(),
            comment: r.try_get("CMT").unwrap_or_default(),
        });
    }
    Ok(out)
}

/// 名前検索で返す最大件数
pub const OBJECT_TOTAL_LIMIT: usize = OBJECT_LIMIT as usize;

/// PostgreSQL: つないでいるデータベースの全スキーマから探す
pub async fn pg_objects(
    conn: &mut PgConnection,
    database: &str,
    needle: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<ObjectHit>, AppError> {
    let pattern = like_pattern(needle);
    let mut out = Vec::new();

    let tables_sql = format!(
        "SELECT n.nspname AS schema, c.relname AS tbl, c.relkind AS kind, \
                COALESCE(obj_description(c.oid, 'pg_class'), '') AS cmt \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition \
           AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' \
           AND (c.relname ILIKE $1 ESCAPE '{LIKE_ESCAPE}' \
                OR COALESCE(obj_description(c.oid, 'pg_class'), '') ILIKE $1 ESCAPE '{LIKE_ESCAPE}') \
         ORDER BY n.nspname, c.relname LIMIT {OBJECT_LIMIT}"
    );
    ctx.qlog.add(ctx.connection, ctx.database, &tables_sql);
    let rows = timeout(
        SEARCH_TIMEOUT,
        sqlx::query(sqlx::AssertSqlSafe(tables_sql.clone()))
            .bind(&pattern)
            .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| AppError::timeout("検索"))?
    .map_err(db_error)?;
    for r in &rows {
        let kind: Option<i8> = r.try_get("kind").unwrap_or_default();
        out.push(ObjectHit {
            database: database.to_string(),
            schema: r.try_get("schema").unwrap_or_default(),
            table: r.try_get("tbl").unwrap_or_default(),
            column: String::new(),
            data_type: pg_kind_label(kind).to_string(),
            comment: r.try_get("cmt").unwrap_or_default(),
        });
    }

    let cols_sql = format!(
        "SELECT n.nspname AS schema, c.relname AS tbl, a.attname AS col, \
                format_type(a.atttypid, a.atttypmod) AS typ, \
                COALESCE(col_description(c.oid, a.attnum), '') AS cmt \
         FROM pg_attribute a \
         JOIN pg_class c ON c.oid = a.attrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition \
           AND a.attnum > 0 AND NOT a.attisdropped \
           AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' \
           AND (a.attname ILIKE $1 ESCAPE '{LIKE_ESCAPE}' \
                OR COALESCE(col_description(c.oid, a.attnum), '') ILIKE $1 ESCAPE '{LIKE_ESCAPE}') \
         ORDER BY n.nspname, c.relname, a.attnum LIMIT {OBJECT_LIMIT}"
    );
    ctx.qlog.add(ctx.connection, ctx.database, &cols_sql);
    let rows = timeout(
        SEARCH_TIMEOUT,
        sqlx::query(sqlx::AssertSqlSafe(cols_sql.clone()))
            .bind(&pattern)
            .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| AppError::timeout("検索"))?
    .map_err(db_error)?;
    for r in &rows {
        out.push(ObjectHit {
            database: database.to_string(),
            schema: r.try_get("schema").unwrap_or_default(),
            table: r.try_get("tbl").unwrap_or_default(),
            column: r.try_get("col").unwrap_or_default(),
            data_type: r.try_get("typ").unwrap_or_default(),
            comment: r.try_get("cmt").unwrap_or_default(),
        });
    }
    Ok(out)
}

/// relkind を読みやすい名前にする
fn pg_kind_label(kind: Option<i8>) -> &'static str {
    match kind.map(|c| c as u8 as char) {
        Some('v') => "VIEW",
        Some('m') => "MATERIALIZED VIEW",
        Some('f') => "FOREIGN TABLE",
        Some('p') => "PARTITIONED TABLE",
        _ => "TABLE",
    }
}

/// SQLite: ファイルの中から探す
pub async fn sqlite_objects(
    conn: &mut SqliteConnection,
    needle: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<ObjectHit>, AppError> {
    let pattern = like_pattern(needle);
    let mut out = Vec::new();

    let tables_sql = format!(
        "SELECT name, type FROM sqlite_master \
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
           AND name LIKE ? ESCAPE '{LIKE_ESCAPE}' \
         ORDER BY name LIMIT {OBJECT_LIMIT}"
    );
    ctx.qlog.add(ctx.connection, ctx.database, &tables_sql);
    let rows = timeout(
        SEARCH_TIMEOUT,
        sqlx::query(sqlx::AssertSqlSafe(tables_sql.clone()))
            .bind(&pattern)
            .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| AppError::timeout("検索"))?
    .map_err(db_error)?;
    for r in &rows {
        out.push(ObjectHit {
            database: String::new(),
            schema: String::new(),
            table: r.try_get("name").unwrap_or_default(),
            column: String::new(),
            data_type: r
                .try_get::<String, _>("type")
                .unwrap_or_default()
                .to_uppercase(),
            comment: String::new(),
        });
    }

    let cols_sql = format!(
        "SELECT m.name AS tbl, p.name AS col, p.\"type\" AS typ \
         FROM sqlite_master m JOIN pragma_table_info(m.name) p \
         WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%' \
           AND p.name LIKE ? ESCAPE '{LIKE_ESCAPE}' \
         ORDER BY m.name, p.cid LIMIT {OBJECT_LIMIT}"
    );
    ctx.qlog.add(ctx.connection, ctx.database, &cols_sql);
    let rows = timeout(
        SEARCH_TIMEOUT,
        sqlx::query(sqlx::AssertSqlSafe(cols_sql.clone()))
            .bind(&pattern)
            .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| AppError::timeout("検索"))?
    .map_err(db_error)?;
    for r in &rows {
        out.push(ObjectHit {
            database: String::new(),
            schema: String::new(),
            table: r.try_get("tbl").unwrap_or_default(),
            column: r.try_get("col").unwrap_or_default(),
            data_type: r.try_get("typ").unwrap_or_default(),
            comment: String::new(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn データベースを選んでいなければ探さない() {
        /*
         * 探す範囲は画面で選んでいるデータベースの中だけ。
         * 選んでいないときに黙って全体を探すと、
         * 画面に出ている範囲と食い違って「今どこを見ているのか」が分からなくなる
         */
        assert_eq!(search_scope(Some("shop")).ok(), Some("shop"));

        for empty in [None, Some(""), Some("   ")] {
            let err = search_scope(empty).expect_err("選んでいなければエラー");
            assert!(err.message.contains("データベースを選んで"), "{err}");
        }
    }

    #[test]
    fn likeのパターンに直す() {
        assert_eq!(like_pattern("abc"), "%abc%");
        // ワイルドカードは打ち消す
        assert_eq!(like_pattern("a%b"), "%a!%b%");
        assert_eq!(like_pattern("a_b"), "%a!_b%");
        // エスケープ文字そのものも打ち消す
        assert_eq!(like_pattern("a!b"), "%a!!b%");
    }
}
