//! データベース・テーブル一覧を取得するカタログクエリ

use serde::Serialize;
use sqlx::mysql::MySqlConnection;
use sqlx::postgres::PgConnection;
use sqlx::sqlite::SqliteConnection;
use sqlx::Row;
use tokio::time::{timeout, Duration};

use std::collections::HashMap;

use crate::db::format_db_error;
use crate::models::{
    ColumnInfo, FkInfo, ForeignKeyInfo, IndexInfo, TableDetail, TableInfo,
};
use crate::query_log::QueryLog;

const QUERY_TIMEOUT: Duration = Duration::from_secs(15);

/// スキーマ全体をまとめて取るクエリのタイムアウト (テーブル数が多いぶん長め)
const SCHEMA_TIMEOUT: Duration = Duration::from_secs(120);

/// クエリログ用のコンテキスト(接続名・DB名)
pub struct LogCtx<'a> {
    pub qlog: &'a QueryLog,
    pub connection: &'a str,
    pub database: &'a str,
}

impl LogCtx<'_> {
    fn log(&self, sql: &str) {
        self.qlog.add(self.connection, self.database, sql);
    }
}

/// 空文字列をNoneにする
fn opt(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.is_empty())
}

/// ログ表示用: MySQLの `?` プレースホルダ2つを実値に置換
fn bind2(sql: &str, a: &str, b: &str) -> String {
    sql.replacen('?', &format!("'{a}'"), 1)
        .replacen('?', &format!("'{b}'"), 1)
}

/// ログ表示用: PostgreSQLの `$1` `$2` プレースホルダを実値に置換
fn bind2_pg(sql: &str, a: &str, b: &str) -> String {
    sql.replace("$1", &format!("'{a}'"))
        .replace("$2", &format!("'{b}'"))
}

/// バイト数を人間可読な文字列にする
fn format_bytes(bytes: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

// ---------- サーバー情報 ----------

/// MySQL: バージョン・デフォルト文字コード・照合順序など
pub async fn mysql_server_info(
    conn: &mut MySqlConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<(String, String)>, String> {
    let sql = "SELECT @@version AS version, \
               @@character_set_server AS charset, @@collation_server AS collation, \
               @@system_time_zone AS tz";
    ctx.log(sql);
    let row = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_one(conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;

    let version: String = row.try_get("version").map_err(format_db_error)?;
    let charset: String = row.try_get("charset").map_err(format_db_error)?;
    let collation: String = row.try_get("collation").map_err(format_db_error)?;
    let tz: Option<String> = row.try_get("tz").map_err(format_db_error)?;

    let mut info = vec![
        ("バージョン".to_string(), format!("MySQL {version}")),
        ("文字コード".into(), charset),
        ("照合順序".into(), collation),
    ];
    if let Some(tz) = opt(tz) {
        info.push(("タイムゾーン".into(), tz));
    }
    Ok(info)
}

/// PostgreSQL: バージョン・エンコーディング・照合順序など
pub async fn pg_server_info(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<(String, String)>, String> {
    let sql = "SELECT current_setting('server_version') AS version, \
                      pg_encoding_to_char(d.encoding) AS encoding, \
                      d.datcollate AS collation, \
                      current_setting('TimeZone') AS tz \
               FROM pg_database d WHERE d.datname = current_database()";
    ctx.log(sql);
    let row = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_one(conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;

    let version: String = row.try_get("version").map_err(format_db_error)?;
    let encoding: String = row.try_get("encoding").map_err(format_db_error)?;
    let collation: String = row.try_get("collation").map_err(format_db_error)?;
    let tz: Option<String> = row.try_get("tz").map_err(format_db_error)?;

    let mut info = vec![
        ("バージョン".to_string(), format!("PostgreSQL {version}")),
        ("エンコーディング".into(), encoding),
        ("照合順序".into(), collation),
    ];
    if let Some(tz) = opt(tz) {
        info.push(("タイムゾーン".into(), tz));
    }
    Ok(info)
}

// ---------- MySQL ----------

/// 文字コード1件と、そこで使える照合順序
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharsetInfo {
    pub name: String,
    /// 読みやすい説明 (PostgreSQLでは空)
    pub description: String,
    /// 何も選ばなかったときに使われる照合順序 (PostgreSQLでは空)
    pub default_collation: String,
    /// この文字コードで使える照合順序 (PostgreSQLでは空)
    pub collations: Vec<String>,
}

/// MySQL: 文字コードと照合順序の一覧。
///
/// 画面で選べるようにするために取る。
/// 手で打たせると綴り違いでエラーになるし、
/// どの照合順序がどの文字コードのものかも分からない
pub async fn mysql_charsets(
    conn: &mut MySqlConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<CharsetInfo>, String> {
    let sql = "SHOW CHARACTER SET";
    ctx.log(sql);
    let sets = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;

    let sql = "SHOW COLLATION";
    ctx.log(sql);
    let colls = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;

    // 文字コードごとに照合順序をまとめる
    let mut by_charset: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for r in &colls {
        let cs: String = r.try_get("Charset").unwrap_or_default();
        let name: String = r.try_get("Collation").unwrap_or_default();
        if cs.is_empty() || name.is_empty() {
            continue;
        }
        by_charset.entry(cs).or_default().push(name);
    }
    for list in by_charset.values_mut() {
        list.sort();
    }

    Ok(sets
        .iter()
        .map(|r| {
            let name: String = r.try_get("Charset").unwrap_or_default();
            let collations = by_charset.remove(&name).unwrap_or_default();
            CharsetInfo {
                description: r.try_get("Description").unwrap_or_default(),
                default_collation: r.try_get("Default collation").unwrap_or_default(),
                collations,
                name,
            }
        })
        .filter(|c| !c.name.is_empty())
        .collect())
}

/// PostgreSQL: 指定できるエンコーディングの一覧。
///
/// サーバーが知っている名前をそのまま聞く (版によって増えるため)
pub async fn pg_encodings(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<CharsetInfo>, String> {
    let sql = "SELECT pg_encoding_to_char(i) AS name \
             FROM generate_series(0, 64) AS i \
             WHERE pg_encoding_to_char(i) <> '' \
             ORDER BY 1";
    ctx.log(sql);
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query_scalar::<_, String>(sql).fetch_all(conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    Ok(rows
        .into_iter()
        .map(|name| CharsetInfo {
            name,
            description: String::new(),
            default_collation: String::new(),
            collations: Vec::new(),
        })
        .collect())
}

pub async fn mysql_databases(
    conn: &mut MySqlConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<String>, String> {
    let sql = "SHOW DATABASES";
    ctx.log(sql);
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query_scalar::<_, String>(sql).fetch_all(conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    Ok(rows)
}

pub async fn mysql_tables(
    conn: &mut MySqlConnection,
    schema: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<TableInfo>, String> {
    let sql = "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS \
               FROM information_schema.TABLES \
               WHERE TABLE_SCHEMA = ? \
               ORDER BY TABLE_NAME";
    ctx.log(&sql.replace('?', &format!("'{schema}'")));
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).bind(schema).fetch_all(conn))
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;

    rows.iter()
        .map(|row| {
            Ok(TableInfo {
                schema: None,
                name: row.try_get("TABLE_NAME").map_err(format_db_error)?,
                table_type: row.try_get("TABLE_TYPE").map_err(format_db_error)?,
                row_estimate: row
                    .try_get::<Option<u64>, _>("TABLE_ROWS")
                    .map_err(format_db_error)?
                    .map(|n| n as i64),
                // パーティションはPostgreSQLだけ扱う
                partition_by: None,
                partition_of: None,
            })
        })
        .collect()
}

/// MySQL: information_schema.COLUMNS の1行 → カラム情報
fn mysql_column(r: &sqlx::mysql::MySqlRow) -> Result<ColumnInfo, String> {
    Ok(ColumnInfo {
        name: r.try_get("COLUMN_NAME").map_err(format_db_error)?,
        col_type: r.try_get("COLUMN_TYPE").map_err(format_db_error)?,
        nullable: r
            .try_get::<String, _>("IS_NULLABLE")
            .map_err(format_db_error)?
            == "YES",
        key: opt(r.try_get("COLUMN_KEY").map_err(format_db_error)?),
        default: r.try_get("COLUMN_DEFAULT").map_err(format_db_error)?,
        extra: opt(r.try_get("EXTRA").map_err(format_db_error)?),
        collation: r.try_get("COLLATION_NAME").map_err(format_db_error)?,
        comment: opt(r.try_get("COLUMN_COMMENT").map_err(format_db_error)?),
    })
}

/// MySQL: information_schema.STATISTICS の1行をインデックス一覧へ足す。
/// 同じインデックス名が続く間は、複合インデックスとしてカラムを連結する
fn mysql_push_index(
    indexes: &mut Vec<IndexInfo>,
    r: &sqlx::mysql::MySqlRow,
    has_expression: bool,
) -> Result<(), String> {
    let name: String = r.try_get("INDEX_NAME").map_err(format_db_error)?;
    // 関数(式)インデックスではCOLUMN_NAMEがNULLになり、式はEXPRESSION列に入る
    // 接頭辞インデックス (col(10)) の長さ。
    // columns はそのまま編集に使うので、長さは別のフィールドへ入れる
    let prefix = r
        .try_get::<Option<i64>, _>("SUB_PART")
        .ok()
        .flatten()
        .filter(|n| *n > 0);
    let column: String = match r
        .try_get::<Option<String>, _>("COLUMN_NAME")
        .map_err(format_db_error)?
    {
        Some(c) => c,
        None => {
            let expr = if has_expression {
                r.try_get::<Option<String>, _>("EXPRESSION").ok().flatten()
            } else {
                None
            };
            expr.map(|e| format!("({e})"))
                .unwrap_or_else(|| "(式インデックス)".to_string())
        }
    };
    if let Some(last) = indexes.last_mut() {
        if last.name == name {
            last.columns.push_str(", ");
            last.columns.push_str(&column);
            last.sub_parts.push(prefix);
            return Ok(());
        }
    }
    let is_primary = name == "PRIMARY";
    indexes.push(IndexInfo {
        name,
        unique: r
            .try_get::<i64, _>("NON_UNIQUE")
            .map_err(format_db_error)?
            == 0,
        columns: column,
        sub_parts: vec![prefix],
        index_type: r.try_get("INDEX_TYPE").map_err(format_db_error)?,
        cardinality: r.try_get("CARDINALITY").map_err(format_db_error)?,
        // MySQLの主キーは常に PRIMARY という名前のインデックスになる
        constrained: is_primary,
    });
    Ok(())
}

/// MySQL: information_schema.TABLES の1行 → 画面に出すテーブル情報
fn mysql_table_info(r: &sqlx::mysql::MySqlRow) -> Result<Vec<(String, String)>, String> {
    let mut info: Vec<(String, String)> = Vec::new();
    let text_fields: [(&str, &str); 6] = [
        ("エンジン", "ENGINE"),
        ("文字コード", "CHARSET"),
        ("照合順序", "TABLE_COLLATION"),
        ("作成", "CREATED"),
        ("更新", "UPDATED"),
        ("コメント", "TABLE_COMMENT"),
    ];
    for (label, col) in text_fields {
        if let Some(v) = opt(r.try_get(col).map_err(format_db_error)?) {
            info.push((label.to_string(), v));
        } else if label == "更新" {
            // InnoDBはサーバー再起動後などにUPDATE_TIMEがNULLになるため "-" で明示する
            info.push((label.to_string(), "-".to_string()));
        }
    }
    if let Some(n) = r
        .try_get::<Option<i64>, _>("TABLE_ROWS")
        .map_err(format_db_error)?
    {
        info.insert(1.min(info.len()), ("概算行数".into(), n.to_string()));
    }
    if let Some(n) = r
        .try_get::<Option<i64>, _>("TOTAL_SIZE")
        .map_err(format_db_error)?
    {
        info.insert(2.min(info.len()), ("サイズ".into(), format_bytes(n)));
    }
    // AUTO_INCREMENTを持つテーブルのみ表示 (値は次に採番される番号)
    if let Some(n) = r
        .try_get::<Option<i64>, _>("AUTO_INC")
        .map_err(format_db_error)?
    {
        info.insert(3.min(info.len()), ("AUTO_INCREMENT".into(), n.to_string()));
    }
    Ok(info)
}

/// PostgreSQL: pg_attribute の1行 → カラム情報
fn pg_column(r: &sqlx::postgres::PgRow) -> Result<ColumnInfo, String> {
    let is_pk: bool = r.try_get("is_pk").map_err(format_db_error)?;
    Ok(ColumnInfo {
        name: r.try_get("name").map_err(format_db_error)?,
        col_type: r.try_get("col_type").map_err(format_db_error)?,
        nullable: r.try_get("nullable").map_err(format_db_error)?,
        key: is_pk.then(|| "PRI".to_string()),
        default: r.try_get("default_expr").map_err(format_db_error)?,
        extra: opt(r.try_get("extra").map_err(format_db_error)?),
        collation: r.try_get("collation").map_err(format_db_error)?,
        comment: r.try_get("comment").map_err(format_db_error)?,
    })
}

/// PostgreSQL: pg_index の1行 → インデックス情報
fn pg_index(r: &sqlx::postgres::PgRow) -> Result<IndexInfo, String> {
    // 定義文からカラム部分 "(...)" を抜き出す
    let definition: String = r.try_get("definition").map_err(format_db_error)?;
    let columns_part = definition
        .split_once('(')
        .map(|(_, rest)| rest.trim_end_matches(')').to_string())
        .unwrap_or(definition);
    Ok(IndexInfo {
        name: r.try_get("name").map_err(format_db_error)?,
        unique: r.try_get("unique_flag").map_err(format_db_error)?,
        columns: columns_part,
        // 接頭辞インデックスはMySQLだけの仕組み
        sub_parts: Vec::new(),
        index_type: r.try_get("index_type").map_err(format_db_error)?,
        cardinality: None,
        constrained: r.try_get("constrained").map_err(format_db_error)?,
    })
}

/// PostgreSQL: pg_class の1行 → 画面に出すテーブル情報
fn pg_table_info(r: &sqlx::postgres::PgRow) -> Result<Vec<(String, String)>, String> {
    let mut info: Vec<(String, String)> = Vec::new();
    let estimate: i64 = r.try_get("row_estimate").map_err(format_db_error)?;
    if estimate >= 0 {
        info.push(("概算行数".into(), estimate.to_string()));
    }
    if let Some(size) = r
        .try_get::<Option<String>, _>("total_size")
        .map_err(format_db_error)?
    {
        info.push(("サイズ".into(), size));
    }
    if let Some(c) = r
        .try_get::<Option<String>, _>("comment")
        .map_err(format_db_error)?
    {
        info.push(("コメント".into(), c));
    }
    Ok(info)
}

/// MySQL: テーブル構造(カラム・インデックス・情報)を取得
pub async fn mysql_table_detail(
    conn: &mut MySqlConnection,
    schema: &str,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<TableDetail, String> {
    // カラム
    let sql = "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, \
                    COLUMN_DEFAULT, EXTRA, COLLATION_NAME, COLUMN_COMMENT \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY ORDINAL_POSITION";
    ctx.log(&bind2(sql, schema, table));
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql)
            .bind(schema)
            .bind(table)
            .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;

    let mut columns = Vec::with_capacity(rows.len());
    for r in &rows {
        columns.push(mysql_column(r)?);
    }

    // インデックス (カラムを1行にまとめる)。
    // EXPRESSION列は関数(式)インデックスの式 (MySQL 8.0.13+)。
    // 古いサーバーには存在しないため、失敗したらEXPRESSIONなしで再取得する。
    // 並び順は主キー(PRIMARY)を先頭に固定し、残りはインデックス名順。
    // 各インデックス内のカラムはSEQ_IN_INDEX順 (複合インデックスの定義順)
    let sql_expr = "SELECT INDEX_NAME, CAST(NON_UNIQUE AS SIGNED) AS NON_UNIQUE, \
                    COLUMN_NAME, EXPRESSION, INDEX_TYPE, \
                    CAST(SUB_PART AS SIGNED) AS SUB_PART, \
                    CAST(CARDINALITY AS SIGNED) AS CARDINALITY \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY (INDEX_NAME = 'PRIMARY') DESC, INDEX_NAME, SEQ_IN_INDEX";
    let sql_plain = "SELECT INDEX_NAME, CAST(NON_UNIQUE AS SIGNED) AS NON_UNIQUE, \
                    COLUMN_NAME, INDEX_TYPE, \
                    CAST(SUB_PART AS SIGNED) AS SUB_PART, \
                    CAST(CARDINALITY AS SIGNED) AS CARDINALITY \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY (INDEX_NAME = 'PRIMARY') DESC, INDEX_NAME, SEQ_IN_INDEX";
    ctx.log(&bind2(sql_expr, schema, table));
    let (rows, has_expression) = match timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql_expr)
            .bind(schema)
            .bind(table)
            .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    {
        Ok(rows) => (rows, true),
        Err(_) => {
            ctx.log(&bind2(sql_plain, schema, table));
            let rows = timeout(
                QUERY_TIMEOUT,
                sqlx::query(sql_plain)
                    .bind(schema)
                    .bind(table)
                    .fetch_all(&mut *conn),
            )
            .await
            .map_err(|_| "クエリがタイムアウトしました".to_string())?
            .map_err(format_db_error)?;
            (rows, false)
        }
    };

    let mut indexes: Vec<IndexInfo> = Vec::new();
    for r in &rows {
        mysql_push_index(&mut indexes, r, has_expression)?;
    }

    // テーブル情報
    let sql = "SELECT T.ENGINE, CAST(T.TABLE_ROWS AS SIGNED) AS TABLE_ROWS, \
                    CAST(T.DATA_LENGTH + IFNULL(T.INDEX_LENGTH, 0) AS SIGNED) AS TOTAL_SIZE, \
                    CAST(T.AUTO_INCREMENT AS SIGNED) AS AUTO_INC, \
                    CCSA.CHARACTER_SET_NAME AS CHARSET, \
                    T.TABLE_COLLATION, CAST(T.CREATE_TIME AS CHAR) AS CREATED, \
                    CAST(T.UPDATE_TIME AS CHAR) AS UPDATED, T.TABLE_COMMENT \
             FROM information_schema.TABLES T \
             LEFT JOIN information_schema.COLLATION_CHARACTER_SET_APPLICABILITY CCSA \
               ON CCSA.COLLATION_NAME = T.TABLE_COLLATION \
             WHERE T.TABLE_SCHEMA = ? AND T.TABLE_NAME = ?";
    ctx.log(&bind2(sql, schema, table));
    let row = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql)
            .bind(schema)
            .bind(table)
            .fetch_optional(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;

    let info = match &row {
        Some(r) => mysql_table_info(r)?,
        None => Vec::new(),
    };

    let foreign_keys = mysql_foreign_key_defs(conn, schema, table, ctx).await?;

    Ok(TableDetail {
        columns,
        indexes,
        foreign_keys,
        info,
    })
}

/// MySQL: 指定DBの外部キー一覧 (ER図用)
pub async fn mysql_foreign_keys(
    conn: &mut MySqlConnection,
    schema: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<FkInfo>, String> {
    let sql = "SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY TABLE_NAME, ORDINAL_POSITION";
    ctx.log(&sql.replace('?', &format!("'{schema}'")));
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).bind(schema).fetch_all(conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;

    rows.iter()
        .map(|r| {
            Ok(FkInfo {
                table: r.try_get("TABLE_NAME").map_err(format_db_error)?,
                column: r.try_get("COLUMN_NAME").map_err(format_db_error)?,
                ref_table: r
                    .try_get("REFERENCED_TABLE_NAME")
                    .map_err(format_db_error)?,
                ref_column: r
                    .try_get("REFERENCED_COLUMN_NAME")
                    .map_err(format_db_error)?,
            })
        })
        .collect()
}

/// PostgreSQL: 接続中DBの外部キー一覧 (ER図用)
pub async fn pg_foreign_keys(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<FkInfo>, String> {
    // pg_constraintから引く (複合FKはカラム位置を対応させて展開する)
    let sql = "SELECT \
                 src.relname AS table_name, \
                 sa.attname AS column_name, \
                 dst.relname AS ref_table, \
                 da.attname AS ref_column \
               FROM pg_constraint c \
               JOIN pg_class src ON src.oid = c.conrelid \
               JOIN pg_class dst ON dst.oid = c.confrelid \
               JOIN pg_namespace n ON n.oid = src.relnamespace \
               CROSS JOIN LATERAL unnest(c.conkey, c.confkey) \
                 WITH ORDINALITY AS k(attnum, ref_attnum, ord) \
               JOIN pg_attribute sa \
                 ON sa.attrelid = c.conrelid AND sa.attnum = k.attnum \
               JOIN pg_attribute da \
                 ON da.attrelid = c.confrelid AND da.attnum = k.ref_attnum \
               WHERE c.contype = 'f' \
                 AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
               ORDER BY src.relname, c.conname, k.ord";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;

    rows.iter()
        .map(|r| {
            Ok(FkInfo {
                table: r.try_get("table_name").map_err(format_db_error)?,
                column: r.try_get("column_name").map_err(format_db_error)?,
                ref_table: r.try_get("ref_table").map_err(format_db_error)?,
                ref_column: r.try_get("ref_column").map_err(format_db_error)?,
            })
        })
        .collect()
}

// ---------- PostgreSQL ----------

pub async fn pg_databases(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<String>, String> {
    let sql = "SELECT datname FROM pg_database \
             WHERE datistemplate = false AND datallowconn \
             ORDER BY datname";
    ctx.log(sql);
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query_scalar::<_, String>(sql).fetch_all(conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    Ok(rows)
}

/// スキーマの一覧 (システムのものは除く)
pub async fn pg_schemas(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<String>, String> {
    let sql = "SELECT nspname FROM pg_namespace \
             WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' \
             ORDER BY nspname";
    ctx.log(sql);
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query_scalar::<_, String>(sql).fetch_all(conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    Ok(rows)
}

/// SQLエディタの補完に出すカラム (名前・型・コメント)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaColumn {
    pub name: String,
    /// 表示用の型名 (取れない場合は空)
    pub data_type: String,
    /// カラムコメント (日本語名の取り出しに使う。SQLiteは常に空)
    pub comment: String,
}

/// SQLエディタの補完に出すテーブル
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTable {
    pub name: String,
    /// テーブルコメント (日本語名の取り出しに使う。SQLiteは常に空)
    pub comment: String,
    pub columns: Vec<SchemaColumn>,
}

/// SQLエディタの補完に使うテーブル・カラムの一覧。
/// 定義の全取得は重いので、必要な列だけを1クエリで集める
pub type SchemaColumns = Vec<SchemaTable>;

/// 取得した (テーブル名, テーブルコメント, カラム) の並びをテーブルごとにまとめる
fn group_columns(rows: Vec<(String, String, SchemaColumn)>) -> SchemaColumns {
    let mut out: SchemaColumns = Vec::new();
    for (table, comment, column) in rows {
        match out.last_mut() {
            Some(t) if t.name == table => t.columns.push(column),
            _ => out.push(SchemaTable {
                name: table,
                comment,
                columns: vec![column],
            }),
        }
    }
    out
}

/// MySQL: 補完用のテーブル・カラム一覧
pub async fn mysql_schema_columns(
    conn: &mut MySqlConnection,
    database: &str,
    ctx: &LogCtx<'_>,
) -> Result<SchemaColumns, String> {
    // ビューのTABLE_COMMENTは 'VIEW' が入るだけなので、日本語名としては使わない
    let sql = "SELECT c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE, c.COLUMN_COMMENT, \
                    CASE WHEN t.TABLE_TYPE = 'VIEW' THEN '' ELSE t.TABLE_COMMENT END AS TBL_COMMENT \
             FROM information_schema.COLUMNS c \
             JOIN information_schema.TABLES t \
               ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
             WHERE c.TABLE_SCHEMA = ? ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION";
    ctx.log(&sql.replacen('?', &format!("'{database}'"), 1));
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(database).fetch_all(conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    let pairs = rows
        .iter()
        .map(|r| {
            Ok((
                r.try_get::<String, _>("TABLE_NAME").map_err(format_db_error)?,
                r.try_get::<String, _>("TBL_COMMENT").map_err(format_db_error)?,
                SchemaColumn {
                    name: r
                        .try_get::<String, _>("COLUMN_NAME")
                        .map_err(format_db_error)?,
                    data_type: r
                        .try_get::<String, _>("COLUMN_TYPE")
                        .map_err(format_db_error)?,
                    comment: r
                        .try_get::<String, _>("COLUMN_COMMENT")
                        .map_err(format_db_error)?,
                },
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(group_columns(pairs))
}

/// PostgreSQL: 補完用のテーブル・カラム一覧 (スキーマ付きの名前も入れる)
pub async fn pg_schema_columns(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<SchemaColumns, String> {
    let sql = "SELECT n.nspname AS schema, c.relname AS tbl, a.attname AS col, \
                    format_type(a.atttypid, a.atttypmod) AS typ, \
                    COALESCE(col_description(c.oid, a.attnum), '') AS cmt, \
                    COALESCE(obj_description(c.oid, 'pg_class'), '') AS tbl_cmt \
             FROM pg_attribute a \
             JOIN pg_class c ON c.oid = a.attrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') \
               AND a.attnum > 0 AND NOT a.attisdropped \
               AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
               AND NOT n.nspname LIKE 'pg_toast%' \
             ORDER BY n.nspname, c.relname, a.attnum";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;

    // 素のテーブル名と "スキーマ.テーブル" の両方で引けるようにする
    let mut plain: Vec<(String, String, SchemaColumn)> = Vec::with_capacity(rows.len());
    let mut qualified: Vec<(String, String, SchemaColumn)> = Vec::with_capacity(rows.len());
    for r in &rows {
        let schema: String = r.try_get("schema").map_err(format_db_error)?;
        let table: String = r.try_get("tbl").map_err(format_db_error)?;
        let col: String = r.try_get("col").map_err(format_db_error)?;
        let typ: String = r.try_get("typ").map_err(format_db_error)?;
        let cmt: String = r.try_get("cmt").map_err(format_db_error)?;
        let tbl_cmt: String = r.try_get("tbl_cmt").map_err(format_db_error)?;
        plain.push((
            table.clone(),
            tbl_cmt.clone(),
            SchemaColumn {
                name: col.clone(),
                data_type: typ.clone(),
                comment: cmt.clone(),
            },
        ));
        qualified.push((
            format!("{schema}.{table}"),
            tbl_cmt,
            SchemaColumn {
                name: col,
                data_type: typ,
                comment: cmt,
            },
        ));
    }
    let mut out = group_columns(plain);
    out.extend(group_columns(qualified));
    Ok(out)
}

/// SQLite: 補完用のテーブル・カラム一覧 (コメントの仕組みが無いので空で返す)
pub async fn sqlite_schema_columns(
    conn: &mut SqliteConnection,
    ctx: &LogCtx<'_>,
) -> Result<SchemaColumns, String> {
    let sql = "SELECT m.name AS tbl, p.name AS col, p.\"type\" AS typ \
             FROM sqlite_master m \
             JOIN pragma_table_info(m.name) p \
             WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%' \
             ORDER BY m.name, p.cid";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
    let pairs = rows
        .iter()
        .map(|r| {
            Ok((
                r.try_get::<String, _>("tbl").map_err(format_db_error)?,
                String::new(),
                SchemaColumn {
                    name: r.try_get::<String, _>("col").map_err(format_db_error)?,
                    data_type: r.try_get::<String, _>("typ").map_err(format_db_error)?,
                    comment: String::new(),
                },
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(group_columns(pairs))
}

/// PostgreSQL: テーブルのカラム名と型 (データ編集のキャストに使う)
pub async fn pg_column_types(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<Vec<(String, String)>, String> {
    let sql = "SELECT a.attname AS name, \
                    format_type(a.atttypid, a.atttypmod) AS type \
             FROM pg_attribute a \
             JOIN pg_class c ON c.oid = a.attrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2 \
               AND a.attnum > 0 AND NOT a.attisdropped";
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(schema).bind(table).fetch_all(conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    rows.iter()
        .map(|r| {
            Ok((
                r.try_get::<String, _>("name").map_err(format_db_error)?,
                r.try_get::<String, _>("type").map_err(format_db_error)?,
            ))
        })
        .collect()
}

/// PostgreSQL: カラムに使える型の一覧。
/// ユーザー定義のenumやドメイン、拡張 (PostGISのgeometry等) も含めたいのでDBから取る
pub async fn pg_types(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<String>, String> {
    // typtype: b=基本型 e=列挙型 d=ドメイン r=範囲型
    // typelem<>0 は配列なので除く (要素型のほうを候補に出す)
    let sql = "SELECT DISTINCT format_type(t.oid, NULL) AS name \
               FROM pg_type t \
               JOIN pg_namespace n ON n.oid = t.typnamespace \
               WHERE t.typtype IN ('b', 'e', 'd', 'r') \
                 AND t.typelem = 0 \
                 AND t.typname NOT LIKE 'pg\\_%' \
                 AND n.nspname <> 'information_schema' \
               ORDER BY name";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
    rows.iter()
        .map(|r| r.try_get::<String, _>("name").map_err(format_db_error))
        .collect()
}

/// MySQL: 使える照合順序の一覧 (よく使うutf8mb4を先頭にまとめる)
pub async fn mysql_collations(
    conn: &mut MySqlConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<String>, String> {
    let sql = "SELECT COLLATION_NAME FROM information_schema.COLLATIONS \
             ORDER BY (CHARACTER_SET_NAME = 'utf8mb4') DESC, \
                      CHARACTER_SET_NAME, COLLATION_NAME";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
    rows.iter()
        .map(|r| {
            r.try_get::<Option<String>, _>("COLLATION_NAME")
                .map_err(format_db_error)
                .map(|v| v.unwrap_or_default())
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|v| v.into_iter().filter(|s| !s.is_empty()).collect())
}

/// PostgreSQL: 使える照合順序の一覧
pub async fn pg_collations(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<String>, String> {
    // 同名の照合順序が複数のスキーマにあることがあるので重複は除く
    let sql = "SELECT DISTINCT collname FROM pg_collation \
             WHERE collname <> 'default' ORDER BY collname";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
    rows.iter()
        .map(|r| r.try_get::<String, _>("collname").map_err(format_db_error))
        .collect()
}

pub async fn pg_tables(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<TableInfo>, String> {
    let sql = "SELECT n.nspname AS schema, \
                    c.relname AS name, \
                    CASE c.relkind \
                      WHEN 'r' THEN 'BASE TABLE' \
                      WHEN 'p' THEN 'BASE TABLE' \
                      WHEN 'v' THEN 'VIEW' \
                      WHEN 'm' THEN 'MATERIALIZED VIEW' \
                      WHEN 'f' THEN 'FOREIGN TABLE' \
                      ELSE c.relkind::text \
                    END AS table_type, \
                    c.reltuples::bigint AS row_estimate, \
                    CASE WHEN c.relkind = 'p' \
                         THEN pg_get_partkeydef(c.oid) ELSE NULL END AS partition_by, \
                    CASE WHEN c.relispartition \
                         THEN pg_get_expr(c.relpartbound, c.oid) ELSE NULL END AS partbound, \
                    pn.nspname AS parent_schema, p.relname AS parent_table \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_inherits i ON i.inhrelid = c.oid \
             LEFT JOIN pg_class p ON p.oid = i.inhparent \
             LEFT JOIN pg_namespace pn ON pn.oid = p.relnamespace \
             WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') \
               AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
               AND NOT n.nspname LIKE 'pg_toast%' \
             ORDER BY n.nspname, c.relname";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(conn))
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;

    rows.iter()
        .map(|row| {
            let estimate: i64 = row.try_get("row_estimate").map_err(format_db_error)?;
            Ok(TableInfo {
                schema: row.try_get("schema").map_err(format_db_error)?,
                name: row.try_get("name").map_err(format_db_error)?,
                table_type: row.try_get("table_type").map_err(format_db_error)?,
                // ANALYZE未実行のテーブルは -1 が入る
                row_estimate: (estimate >= 0).then_some(estimate),
                partition_by: row.try_get("partition_by").ok().flatten(),
                partition_of: pg_partition_parent(row),
            })
        })
        .collect()
}

/// 一覧の1行から「パーティションの子」の情報を取り出す
fn pg_partition_parent(row: &sqlx::postgres::PgRow) -> Option<(String, String)> {
    let ident = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    let bound: Option<String> = row.try_get("partbound").ok().flatten();
    let schema: Option<String> = row.try_get("parent_schema").ok().flatten();
    let name: Option<String> = row.try_get("parent_table").ok().flatten();
    match (bound, schema, name) {
        (Some(b), Some(s), Some(n)) => Some((format!("{}.{}", ident(&s), ident(&n)), b)),
        _ => None,
    }
}

/// PostgreSQL: テーブル構造(カラム・インデックス・情報)を取得
pub async fn pg_table_detail(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<TableDetail, String> {
    // カラム
    let sql = "SELECT a.attname AS name, \
                    format_type(a.atttypid, a.atttypmod) AS col_type, \
                    NOT a.attnotnull AS nullable, \
                    pg_get_expr(ad.adbin, ad.adrelid) AS default_expr, \
                    col_description(a.attrelid, a.attnum) AS comment, \
                    COALESCE((SELECT true FROM pg_index i \
                              WHERE i.indrelid = a.attrelid AND i.indisprimary \
                                AND a.attnum = ANY(i.indkey)), false) AS is_pk, \
                    CASE WHEN a.attgenerated = 's' THEN 'stored generated' \
                         WHEN a.attidentity = 'a' THEN 'identity always' \
                         WHEN a.attidentity = 'd' THEN 'identity by default' \
                         ELSE '' END AS extra, \
                    (SELECT co.collname FROM pg_collation co \
                     WHERE co.oid = a.attcollation) AS collation \
             FROM pg_attribute a \
             JOIN pg_class c ON c.oid = a.attrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_attrdef ad \
               ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             WHERE n.nspname = $1 AND c.relname = $2 \
               AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum";
    ctx.log(&bind2_pg(sql, schema, table));
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql)
            .bind(schema)
            .bind(table)
            .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;

    let mut columns = Vec::with_capacity(rows.len());
    for r in &rows {
        columns.push(pg_column(r)?);
    }

    // インデックス (主キーを先頭に固定し、残りはインデックス名順)
    let sql = "SELECT i.relname AS name, ix.indisunique AS unique_flag, \
                    am.amname AS index_type, \
                    (ix.indisprimary OR con.oid IS NOT NULL) AS constrained, \
                    pg_get_indexdef(ix.indexrelid) AS definition \
             FROM pg_index ix \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             LEFT JOIN pg_am am ON am.oid = i.relam \
             LEFT JOIN pg_constraint con \
               ON con.conindid = i.oid AND con.conrelid = t.oid \
                  AND con.contype IN ('p', 'u', 'x') \
             WHERE n.nspname = $1 AND t.relname = $2 \
             ORDER BY ix.indisprimary DESC, i.relname";
    ctx.log(&bind2_pg(sql, schema, table));
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql)
            .bind(schema)
            .bind(table)
            .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;

    let mut indexes = Vec::with_capacity(rows.len());
    for r in &rows {
        indexes.push(pg_index(r)?);
    }

    // テーブル情報
    let sql = "SELECT c.reltuples::bigint AS row_estimate, \
                    pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size, \
                    obj_description(c.oid) AS comment \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2";
    ctx.log(&bind2_pg(sql, schema, table));
    let row = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql)
            .bind(schema)
            .bind(table)
            .fetch_optional(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;

    let info = match &row {
        Some(r) => pg_table_info(r)?,
        None => Vec::new(),
    };

    let foreign_keys = pg_foreign_key_defs(conn, schema, table, ctx).await?;

    Ok(TableDetail {
        columns,
        indexes,
        foreign_keys,
        info,
    })
}

// ---------- SQLite ----------

/// SQLite: バージョン・文字コード・ファイルサイズなど
pub async fn sqlite_server_info(
    conn: &mut SqliteConnection,
    path: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<(String, String)>, String> {
    let sql = "SELECT sqlite_version() AS version, \
               (SELECT encoding FROM pragma_encoding()) AS encoding, \
               (SELECT page_size FROM pragma_page_size()) AS page_size";
    ctx.log(sql);
    let row = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_one(conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;

    let version: String = row.try_get("version").map_err(format_db_error)?;
    let encoding: String = row.try_get("encoding").map_err(format_db_error)?;
    let page_size: i64 = row.try_get("page_size").map_err(format_db_error)?;

    let mut info = vec![
        ("バージョン".to_string(), format!("SQLite {version}")),
        ("文字コード".into(), encoding),
        ("ページサイズ".into(), format_bytes(page_size)),
    ];
    // ファイルサイズはOSから直接読む (PRAGMAより確実)
    if let Ok(meta) = std::fs::metadata(path) {
        info.push(("ファイルサイズ".into(), format_bytes(meta.len() as i64)));
    }
    Ok(info)
}

/// SQLite: テーブル・ビュー一覧 (内部テーブル sqlite_* は除く)
pub async fn sqlite_tables(
    conn: &mut SqliteConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<TableInfo>, String> {
    let sql = "SELECT name, type FROM sqlite_master \
               WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
               ORDER BY name";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;

    rows.iter()
        .map(|row| {
            let kind: String = row.try_get("type").map_err(format_db_error)?;
            Ok(TableInfo {
                schema: None,
                name: row.try_get("name").map_err(format_db_error)?,
                table_type: if kind == "view" {
                    "VIEW".to_string()
                } else {
                    "BASE TABLE".to_string()
                },
                // SQLiteには統計情報が無いため概算行数は出さない
                row_estimate: None,
                partition_by: None,
                partition_of: None,
            })
        })
        .collect()
}

/// SQLite: テーブル構造 (カラム・インデックス・情報)。
/// カラムやインデックスはPRAGMAのテーブル値関数で取得する
pub async fn sqlite_table_detail(
    conn: &mut SqliteConnection,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<TableDetail, String> {
    // カラム (SQLiteにはカラムコメントの概念が無い)
    let sql = "SELECT name, type, \"notnull\", dflt_value, pk \
               FROM pragma_table_info(?) ORDER BY cid";
    ctx.log(&sql.replacen('?', &format!("'{table}'"), 1));
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(table).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;

    let mut columns = Vec::with_capacity(rows.len());
    // 主キーのカラム (pkは1始まりの並び順)
    let mut pk_columns: Vec<(i64, String)> = Vec::new();
    for r in &rows {
        let notnull: i64 = r.try_get("notnull").map_err(format_db_error)?;
        let pk: i64 = r.try_get("pk").map_err(format_db_error)?;
        if pk > 0 {
            pk_columns.push((pk, r.try_get("name").map_err(format_db_error)?));
        }
        let col_type: String = r.try_get("type").map_err(format_db_error)?;
        columns.push(ColumnInfo {
            name: r.try_get("name").map_err(format_db_error)?,
            // 型指定なしのカラム (型親和性なし) は空文字になる
            col_type: if col_type.is_empty() {
                "(型指定なし)".to_string()
            } else {
                col_type
            },
            nullable: notnull == 0,
            key: (pk > 0).then(|| "PRI".to_string()),
            default: r
                .try_get::<Option<String>, _>("dflt_value")
                .map_err(format_db_error)?,
            extra: None,
            collation: None,
            comment: None,
        });
    }

    // インデックス (PRIMARY KEY / UNIQUE 由来のものも含む)
    let sql = "SELECT name, \"unique\", origin, partial FROM pragma_index_list(?)";
    ctx.log(&sql.replacen('?', &format!("'{table}'"), 1));
    let idx_rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(table).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;

    let mut indexes = Vec::with_capacity(idx_rows.len());
    for r in &idx_rows {
        let name: String = r.try_get("name").map_err(format_db_error)?;
        let unique: i64 = r.try_get("unique").map_err(format_db_error)?;
        let origin: String = r.try_get("origin").map_err(format_db_error)?;
        let partial: i64 = r.try_get("partial").map_err(format_db_error)?;

        // インデックスを構成するカラム (seqno順)
        let col_sql = "SELECT name FROM pragma_index_info(?) ORDER BY seqno";
        ctx.log(&col_sql.replacen('?', &format!("'{name}'"), 1));
        let cols = timeout(
            QUERY_TIMEOUT,
            sqlx::query(col_sql).bind(&name).fetch_all(&mut *conn),
        )
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
        let columns_text = cols
            .iter()
            .map(|c| {
                c.try_get::<Option<String>, _>("name")
                    .map_err(format_db_error)
                    // 式インデックスはカラム名がNULLになる
                    .map(|v| v.unwrap_or_else(|| "(式)".to_string()))
            })
            .collect::<Result<Vec<_>, String>>()?
            .join(", ");

        indexes.push(IndexInfo {
            name,
            unique: unique != 0,
            columns: columns_text,
            sub_parts: Vec::new(),
            index_type: Some(match origin.as_str() {
                "pk" => "PRIMARY KEY".to_string(),
                "u" => "UNIQUE制約".to_string(),
                _ if partial != 0 => "部分インデックス".to_string(),
                _ => "INDEX".to_string(),
            }),
            cardinality: None,
            // origin: c=CREATE INDEX, pk=主キー, u=UNIQUE制約
            constrained: origin != "c",
        });
    }
    // 主キー由来のインデックスを先頭にする (他DBの表示と揃える)
    indexes.sort_by_key(|i| i.index_type.as_deref() != Some("PRIMARY KEY"));

    // INTEGER PRIMARY KEY はrowid自体なので専用のインデックスが作られず、
    // pragma_index_listにも出てこない。主キーが分からないと紛らわしいので補う
    let has_pk_index = indexes
        .iter()
        .any(|i| i.index_type.as_deref() == Some("PRIMARY KEY"));
    if !has_pk_index && !pk_columns.is_empty() {
        pk_columns.sort_by_key(|(seq, _)| *seq);
        indexes.insert(
            0,
            IndexInfo {
                name: "PRIMARY".into(),
                unique: true,
                sub_parts: Vec::new(),
                columns: pk_columns
                    .iter()
                    .map(|(_, name)| name.clone())
                    .collect::<Vec<_>>()
                    .join(", "),
                index_type: Some("PRIMARY KEY (rowid)".into()),
                cardinality: None,
                constrained: true,
            },
        );
    }

    // テーブル情報 (種別と定義SQL)
    let sql = "SELECT type, sql FROM sqlite_master WHERE name = ?";
    ctx.log(&sql.replacen('?', &format!("'{table}'"), 1));
    let row = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(table).fetch_optional(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;

    let mut info = Vec::new();
    if let Some(r) = row {
        let kind: String = r.try_get("type").map_err(format_db_error)?;
        info.push((
            "種別".to_string(),
            if kind == "view" {
                "ビュー".to_string()
            } else {
                "テーブル".to_string()
            },
        ));
        // ビューは定義SQL (SELECT文) が他の欄に出ないため表示する。
        // テーブルのCREATE文はカラム・インデックス欄と重複するので出さない
        if kind == "view" {
            if let Some(ddl) = r
                .try_get::<Option<String>, _>("sql")
                .map_err(format_db_error)?
            {
                let one_line = ddl.split_whitespace().collect::<Vec<_>>().join(" ");
                info.push(("定義".into(), one_line));
            }
        }
    }

    let foreign_keys = sqlite_foreign_key_defs(conn, table, ctx).await?;

    Ok(TableDetail {
        columns,
        indexes,
        foreign_keys,
        info,
    })
}

/// SQLite: 全テーブルの外部キー一覧 (ER図用)
pub async fn sqlite_foreign_keys(
    conn: &mut SqliteConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<FkInfo>, String> {
    // 参照先カラム(to)は省略できるため、その場合は参照先の主キーで補う
    let sql = "SELECT m.name AS table_name, fk.\"from\" AS column_name, \
                    fk.\"table\" AS ref_table, fk.\"to\" AS ref_column \
             FROM sqlite_master m, pragma_foreign_key_list(m.name) fk \
             WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
             ORDER BY m.name, fk.id, fk.seq";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;

    let mut fks = Vec::with_capacity(rows.len());
    for r in &rows {
        let ref_table: String = r.try_get("ref_table").map_err(format_db_error)?;
        let ref_column: Option<String> = r.try_get("ref_column").map_err(format_db_error)?;
        let ref_column = match ref_column {
            Some(c) => c,
            None => sqlite_primary_key(conn, &ref_table).await?,
        };
        fks.push(FkInfo {
            table: r.try_get("table_name").map_err(format_db_error)?,
            column: r.try_get("column_name").map_err(format_db_error)?,
            ref_table,
            ref_column,
        });
    }
    Ok(fks)
}

/// SQLite: 指定テーブルの主キーカラム名 (無ければ rowid)
async fn sqlite_primary_key(conn: &mut SqliteConnection, table: &str) -> Result<String, String> {
    let sql = "SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk LIMIT 1";
    let row = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(table).fetch_optional(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    match row {
        Some(r) => r.try_get("name").map_err(format_db_error),
        None => Ok("rowid".to_string()),
    }
}

// ---------- スキーマ全体の定義をまとめて取得 ----------
//
// 差分ビューア・ER図はテーブルごとに定義を取りに行くと
// 「テーブル数 × 3回」の往復になり、テーブルが多いDBでは実用にならない。
// そこでスキーマ全体を数クエリで取り、テーブルごとに振り分ける

/// MySQL: 指定DBの全テーブルの定義 (テーブル名 → 定義)
pub async fn mysql_schema_details(
    conn: &mut MySqlConnection,
    database: &str,
    ctx: &LogCtx<'_>,
) -> Result<HashMap<String, TableDetail>, String> {
    let mut out: HashMap<String, TableDetail> = HashMap::new();

    // カラム
    let sql = "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, \
                    COLUMN_DEFAULT, EXTRA, COLLATION_NAME, COLUMN_COMMENT \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? \
             ORDER BY TABLE_NAME, ORDINAL_POSITION";
    ctx.log(&sql.replacen('?', &format!("'{database}'"), 1));
    let rows = timeout(
        SCHEMA_TIMEOUT,
        sqlx::query(sql).bind(database).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    for r in &rows {
        let table: String = r.try_get("TABLE_NAME").map_err(format_db_error)?;
        out.entry(table).or_default().columns.push(mysql_column(r)?);
    }

    // インデックス (EXPRESSIONは MySQL 8.0.13+。無いサーバーでは付けずに取り直す)
    let sql_expr = "SELECT TABLE_NAME, INDEX_NAME, CAST(NON_UNIQUE AS SIGNED) AS NON_UNIQUE, \
                    COLUMN_NAME, EXPRESSION, INDEX_TYPE, \
                    CAST(SUB_PART AS SIGNED) AS SUB_PART, \
                    CAST(CARDINALITY AS SIGNED) AS CARDINALITY \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? \
             ORDER BY TABLE_NAME, (INDEX_NAME = 'PRIMARY') DESC, INDEX_NAME, SEQ_IN_INDEX";
    let sql_plain = "SELECT TABLE_NAME, INDEX_NAME, CAST(NON_UNIQUE AS SIGNED) AS NON_UNIQUE, \
                    COLUMN_NAME, INDEX_TYPE, \
                    CAST(SUB_PART AS SIGNED) AS SUB_PART, \
                    CAST(CARDINALITY AS SIGNED) AS CARDINALITY \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? \
             ORDER BY TABLE_NAME, (INDEX_NAME = 'PRIMARY') DESC, INDEX_NAME, SEQ_IN_INDEX";
    ctx.log(&sql_expr.replacen('?', &format!("'{database}'"), 1));
    let (rows, has_expression) = match timeout(
        SCHEMA_TIMEOUT,
        sqlx::query(sql_expr).bind(database).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    {
        Ok(rows) => (rows, true),
        Err(_) => {
            ctx.log(&sql_plain.replacen('?', &format!("'{database}'"), 1));
            let rows = timeout(
                SCHEMA_TIMEOUT,
                sqlx::query(sql_plain).bind(database).fetch_all(&mut *conn),
            )
            .await
            .map_err(|_| "クエリがタイムアウトしました".to_string())?
            .map_err(format_db_error)?;
            (rows, false)
        }
    };
    for r in &rows {
        let table: String = r.try_get("TABLE_NAME").map_err(format_db_error)?;
        let d = out.entry(table).or_default();
        mysql_push_index(&mut d.indexes, r, has_expression)?;
    }

    // テーブル情報
    let sql = "SELECT T.TABLE_NAME, T.ENGINE, CAST(T.TABLE_ROWS AS SIGNED) AS TABLE_ROWS, \
                    CAST(T.DATA_LENGTH + IFNULL(T.INDEX_LENGTH, 0) AS SIGNED) AS TOTAL_SIZE, \
                    CAST(T.AUTO_INCREMENT AS SIGNED) AS AUTO_INC, \
                    CCSA.CHARACTER_SET_NAME AS CHARSET, \
                    T.TABLE_COLLATION, CAST(T.CREATE_TIME AS CHAR) AS CREATED, \
                    CAST(T.UPDATE_TIME AS CHAR) AS UPDATED, T.TABLE_COMMENT \
             FROM information_schema.TABLES T \
             LEFT JOIN information_schema.COLLATION_CHARACTER_SET_APPLICABILITY CCSA \
               ON CCSA.COLLATION_NAME = T.TABLE_COLLATION \
             WHERE T.TABLE_SCHEMA = ?";
    ctx.log(&sql.replacen('?', &format!("'{database}'"), 1));
    let rows = timeout(
        SCHEMA_TIMEOUT,
        sqlx::query(sql).bind(database).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    for r in &rows {
        let table: String = r.try_get("TABLE_NAME").map_err(format_db_error)?;
        out.entry(table).or_default().info = mysql_table_info(r)?;
    }

    Ok(out)
}

/// PostgreSQL: 全テーブルの定義 ((スキーマ, テーブル名) → 定義)
pub async fn pg_schema_details(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<HashMap<(String, String), TableDetail>, String> {
    let mut out: HashMap<(String, String), TableDetail> = HashMap::new();

    // カラム
    let sql = "SELECT n.nspname AS schema, c.relname AS tbl, \
                    a.attname AS name, \
                    format_type(a.atttypid, a.atttypmod) AS col_type, \
                    NOT a.attnotnull AS nullable, \
                    pg_get_expr(ad.adbin, ad.adrelid) AS default_expr, \
                    col_description(a.attrelid, a.attnum) AS comment, \
                    COALESCE((SELECT true FROM pg_index i \
                              WHERE i.indrelid = a.attrelid AND i.indisprimary \
                                AND a.attnum = ANY(i.indkey)), false) AS is_pk, \
                    CASE WHEN a.attgenerated = 's' THEN 'stored generated' \
                         WHEN a.attidentity = 'a' THEN 'identity always' \
                         WHEN a.attidentity = 'd' THEN 'identity by default' \
                         ELSE '' END AS extra, \
                    (SELECT co.collname FROM pg_collation co \
                     WHERE co.oid = a.attcollation) AS collation \
             FROM pg_attribute a \
             JOIN pg_class c ON c.oid = a.attrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_attrdef ad \
               ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             WHERE a.attnum > 0 AND NOT a.attisdropped \
               AND c.relkind IN ('r', 'p', 'v', 'm', 'f') \
               AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
               AND NOT n.nspname LIKE 'pg_toast%' \
             ORDER BY n.nspname, c.relname, a.attnum";
    ctx.log(sql);
    let rows = timeout(SCHEMA_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
    for r in &rows {
        let key = (
            r.try_get::<String, _>("schema").map_err(format_db_error)?,
            r.try_get::<String, _>("tbl").map_err(format_db_error)?,
        );
        out.entry(key).or_default().columns.push(pg_column(r)?);
    }

    // インデックス
    let sql = "SELECT n.nspname AS schema, t.relname AS tbl, \
                    i.relname AS name, ix.indisunique AS unique_flag, \
                    am.amname AS index_type, \
                    (ix.indisprimary OR con.oid IS NOT NULL) AS constrained, \
                    pg_get_indexdef(ix.indexrelid) AS definition \
             FROM pg_index ix \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             LEFT JOIN pg_am am ON am.oid = i.relam \
             LEFT JOIN pg_constraint con \
               ON con.conindid = i.oid AND con.conrelid = t.oid \
                  AND con.contype IN ('p', 'u', 'x') \
             WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') \
               AND NOT n.nspname LIKE 'pg_toast%' \
             ORDER BY n.nspname, t.relname, ix.indisprimary DESC, i.relname";
    ctx.log(sql);
    let rows = timeout(SCHEMA_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
    for r in &rows {
        let key = (
            r.try_get::<String, _>("schema").map_err(format_db_error)?,
            r.try_get::<String, _>("tbl").map_err(format_db_error)?,
        );
        out.entry(key).or_default().indexes.push(pg_index(r)?);
    }

    // テーブル情報
    let sql = "SELECT n.nspname AS schema, c.relname AS tbl, \
                    c.reltuples::bigint AS row_estimate, \
                    pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size, \
                    obj_description(c.oid) AS comment \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') \
               AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
               AND NOT n.nspname LIKE 'pg_toast%'";
    ctx.log(sql);
    let rows = timeout(SCHEMA_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
    for r in &rows {
        let key = (
            r.try_get::<String, _>("schema").map_err(format_db_error)?,
            r.try_get::<String, _>("tbl").map_err(format_db_error)?,
        );
        out.entry(key).or_default().info = pg_table_info(r)?;
    }

    Ok(out)
}

// ---------- CREATE文 (定義の共有・コピー用) ----------

/// MySQL: SHOW CREATE TABLE の結果
pub async fn mysql_table_ddl(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<String, String> {
    // 識別子はバッククォートで囲む (中のバッククォートは重ねてエスケープ)
    let ident = |s: &str| format!("`{}`", s.replace('`', "``"));
    // DB名が分からないときは修飾せず、接続中のDBのテーブルとして扱う
    let target = if database.is_empty() {
        ident(table)
    } else {
        format!("{}.{}", ident(database), ident(table))
    };
    let sql = format!("SHOW CREATE TABLE {target}");
    ctx.log(&sql);
    let row = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sqlx::AssertSqlSafe(sql)).fetch_one(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    // 2列目が定義 (テーブルは "Create Table"、ビューは "Create View")
    row.try_get::<String, _>(1).map_err(format_db_error)
}

/// SQLite: sqlite_master に記録されている定義 (テーブル本体 + インデックス)
pub async fn sqlite_table_ddl(
    conn: &mut SqliteConnection,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<String, String> {
    let sql = "SELECT sql FROM sqlite_master \
               WHERE tbl_name = ? AND sql IS NOT NULL \
               ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 0 ELSE 1 END, name";
    ctx.log(&sql.replacen('?', &format!("'{table}'"), 1));
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(table).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    let mut parts: Vec<String> = Vec::new();
    for r in &rows {
        let s: String = r.try_get("sql").map_err(format_db_error)?;
        parts.push(format!("{};", s.trim()));
    }
    if parts.is_empty() {
        return Err("定義が見つかりません".into());
    }
    Ok(parts.join("\n\n"))
}

/// PostgreSQL: カタログから CREATE TABLE 文を組み立てる。
/// PostgreSQLには SHOW CREATE TABLE が無いため、
/// カラム・制約・インデックス・コメントを集めて再構成する
pub async fn pg_table_ddl(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<String, String> {
    // 識別子を二重引用符で囲む
    let ident = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    let full = format!("{}.{}", ident(schema), ident(table));

    /*
     * ビュー・マテビューは定義文をそのまま返す (列を並べても実物にならない)。
     * あわせてパーティションの情報も取る:
     * - `partkey` … このテーブル自身が親 (PARTITION BY … を付ける)
     * - `partbound` … このテーブルが子 (CREATE TABLE … PARTITION OF 親 … になる)
     */
    let sql = "SELECT c.relkind::text AS kind, \
                    CASE WHEN c.relkind IN ('v', 'm') \
                         THEN pg_get_viewdef(c.oid, true) ELSE NULL END AS viewdef, \
                    CASE WHEN c.relkind = 'p' \
                         THEN pg_get_partkeydef(c.oid) ELSE NULL END AS partkey, \
                    CASE WHEN c.relispartition \
                         THEN pg_get_expr(c.relpartbound, c.oid) ELSE NULL END AS partbound, \
                    pn.nspname AS parent_schema, p.relname AS parent_table \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_inherits i ON i.inhrelid = c.oid \
             LEFT JOIN pg_class p ON p.oid = i.inhparent \
             LEFT JOIN pg_namespace pn ON pn.oid = p.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2 \
             ORDER BY p.relname LIMIT 1";
    ctx.log(&bind2_pg(sql, schema, table));
    let row = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql)
            .bind(schema)
            .bind(table)
            .fetch_optional(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    let mut part_key: Option<String> = None;
    let mut part_of: Option<(String, String)> = None;
    if let Some(r) = &row {
        let kind: String = r.try_get("kind").map_err(format_db_error)?;
        if kind == "v" || kind == "m" {
            let def: String = r
                .try_get::<Option<String>, _>("viewdef")
                .map_err(format_db_error)?
                .unwrap_or_default();
            let head = if kind == "m" {
                "CREATE MATERIALIZED VIEW"
            } else {
                "CREATE VIEW"
            };
            return Ok(format!("{head} {full} AS\n{}", def.trim()));
        }
        part_key = r.try_get::<Option<String>, _>("partkey").ok().flatten();
        let bound = r.try_get::<Option<String>, _>("partbound").ok().flatten();
        let ps = r.try_get::<Option<String>, _>("parent_schema").ok().flatten();
        let pt = r.try_get::<Option<String>, _>("parent_table").ok().flatten();
        if let (Some(bound), Some(ps), Some(pt)) = (bound, ps, pt) {
            part_of = Some((format!("{}.{}", ident(&ps), ident(&pt)), bound));
        }
    }

    /*
     * パーティションの子は列を並べ直さない (親から引き継ぐ)。
     * `CREATE TABLE 子 PARTITION OF 親 FOR VALUES …` が本来の形
     */
    if let Some((parent, bound)) = &part_of {
        let out = pg_partition_of(&full, parent, bound, part_key.as_deref());
        let extra = pg_table_extras(conn, schema, table, &full, ctx).await?;
        return Ok(format!("{out}{extra}"));
    }

    // カラム
    let sql = "SELECT a.attname AS name, \
                    format_type(a.atttypid, a.atttypmod) AS col_type, \
                    a.attnotnull AS notnull, \
                    pg_get_expr(ad.adbin, ad.adrelid) AS default_expr, \
                    CASE a.attidentity \
                      WHEN 'a' THEN ' GENERATED ALWAYS AS IDENTITY' \
                      WHEN 'd' THEN ' GENERATED BY DEFAULT AS IDENTITY' \
                      ELSE '' END AS identity, \
                    a.attgenerated = 's' AS generated, \
                    col_description(a.attrelid, a.attnum) AS comment \
             FROM pg_attribute a \
             JOIN pg_class c ON c.oid = a.attrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             WHERE n.nspname = $1 AND c.relname = $2 \
               AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum";
    ctx.log(&bind2_pg(sql, schema, table));
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql)
            .bind(schema)
            .bind(table)
            .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    if rows.is_empty() {
        return Err("定義が見つかりません".into());
    }

    let mut lines: Vec<String> = Vec::new();
    let mut comments: Vec<String> = Vec::new();
    for r in &rows {
        let name: String = r.try_get("name").map_err(format_db_error)?;
        let col_type: String = r.try_get("col_type").map_err(format_db_error)?;
        let notnull: bool = r.try_get("notnull").map_err(format_db_error)?;
        let identity: String = r.try_get("identity").map_err(format_db_error)?;
        let generated: bool = r.try_get("generated").map_err(format_db_error)?;
        let default: Option<String> = r.try_get("default_expr").map_err(format_db_error)?;
        let mut line = format!("    {} {}", ident(&name), col_type);
        line.push_str(&identity);
        if generated {
            // 生成列: 式は pg_attrdef に入っているが DEFAULT ではない
            if let Some(d) = default {
                line.push_str(&format!(" GENERATED ALWAYS AS ({d}) STORED"));
            }
        } else if identity.is_empty() {
            // IDENTITY列のDEFAULTは内部表現なので出さない
            if let Some(d) = default {
                line.push_str(&format!(" DEFAULT {d}"));
            }
        }
        if notnull {
            line.push_str(" NOT NULL");
        }
        lines.push(line);
        if let Some(c) = r
            .try_get::<Option<String>, _>("comment")
            .map_err(format_db_error)?
        {
            comments.push(format!(
                "COMMENT ON COLUMN {full}.{} IS {};",
                ident(&name),
                pg_literal(&c)
            ));
        }
    }

    // 制約 (主キー・一意・外部キー・CHECK)
    let sql = "SELECT conname, pg_get_constraintdef(con.oid) AS def \
             FROM pg_constraint con \
             JOIN pg_class c ON c.oid = con.conrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2 \
               AND con.contype IN ('p', 'u', 'f', 'c', 'x') \
               AND con.conislocal \
             ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 \
                                       WHEN 'f' THEN 2 ELSE 3 END, conname";
    ctx.log(&bind2_pg(sql, schema, table));
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql)
            .bind(schema)
            .bind(table)
            .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    for r in &rows {
        let name: String = r.try_get("conname").map_err(format_db_error)?;
        let def: String = r.try_get("def").map_err(format_db_error)?;
        lines.push(format!("    CONSTRAINT {} {}", ident(&name), def));
    }

    let mut out = pg_create_table(&full, &lines, part_key.as_deref());
    let extra = pg_table_extras(conn, schema, table, &full, ctx).await?;
    out.push_str(&extra);
    for c in comments {
        out.push_str(&format!("\n{c}"));
    }

    Ok(out)
}

/// パーティションの子の CREATE 文。
///
/// 列は親から引き継ぐので並べ直さない。
/// `bound` は `pg_get_expr(relpartbound, oid)` の値
/// (`FOR VALUES FROM (…) TO (…)` や `DEFAULT` の形で返る)
fn pg_partition_of(full: &str, parent: &str, bound: &str, sub_key: Option<&str>) -> String {
    let mut out = format!("CREATE TABLE {full} PARTITION OF {parent}\n    {bound}");
    // 子がさらに分かれている場合
    if let Some(key) = sub_key {
        out.push_str(&format!("\n    PARTITION BY {key}"));
    }
    out.push(';');
    out
}

/// 普通のテーブル (とパーティションの親) の CREATE 文
fn pg_create_table(full: &str, lines: &[String], part_key: Option<&str>) -> String {
    let mut out = format!("CREATE TABLE {full} (\n{}\n)", lines.join(",\n"));
    // パーティションの親: どう分けるかは列の並びの後ろに書く
    if let Some(key) = part_key {
        out.push_str(&format!("\nPARTITION BY {key}"));
    }
    out.push(';');
    out
}

/// テーブル本体の後ろに付ける定義 (インデックスとテーブルコメント)。
/// 普通のテーブルとパーティションの子で共通に使う
async fn pg_table_extras(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
    full: &str,
    ctx: &LogCtx<'_>,
) -> Result<String, String> {
    let mut out = String::new();

    // インデックス (制約が作るものは呼び出し側で出ているので除く)
    let sql = "SELECT pg_get_indexdef(ix.indexrelid) AS def \
             FROM pg_index ix \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             LEFT JOIN pg_constraint con \
               ON con.conindid = i.oid AND con.conrelid = t.oid \
                  AND con.contype IN ('p', 'u', 'x') \
             WHERE n.nspname = $1 AND t.relname = $2 AND con.oid IS NULL \
             ORDER BY i.relname";
    ctx.log(&bind2_pg(sql, schema, table));
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql)
            .bind(schema)
            .bind(table)
            .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    for r in &rows {
        let def: String = r.try_get("def").map_err(format_db_error)?;
        out.push_str(&format!("\n\n{def};"));
    }

    // テーブルコメント
    let sql = "SELECT obj_description(c.oid) AS comment \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2";
    ctx.log(&bind2_pg(sql, schema, table));
    let row = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql)
            .bind(schema)
            .bind(table)
            .fetch_optional(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    if let Some(c) = row.and_then(|r| r.try_get::<Option<String>, _>("comment").ok().flatten()) {
        out.push_str(&format!("\n\nCOMMENT ON TABLE {full} IS {};", pg_literal(&c)));
    }
    Ok(out)
}

/// PostgreSQLの文字列リテラル (シングルクォートを重ねてエスケープ)
fn pg_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// ビュー以外の定義物 (関数・プロシージャ・トリガ) 1件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInfo {
    /// 種別 ("関数" / "プロシージャ" / "トリガ")
    pub kind: String,
    /// スキーマ (MySQL/SQLiteは空)
    pub schema: String,
    pub name: String,
    /// 引数や対象テーブルなど、名前だけでは分からない補足
    pub detail: String,
    /// CREATE文 (取得できないときは空)
    pub definition: String,
}

/// 定義を読めなかったときに本文の代わりに出す説明
const NO_DEFINITION: &str = "-- 定義を取得できませんでした (権限が足りない可能性があります)";

/// MySQL: 関数・プロシージャ・トリガの定義
pub async fn mysql_routines(
    conn: &mut MySqlConnection,
    database: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<RoutineInfo>, String> {
    let mut out = Vec::new();

    let sql = "SELECT ROUTINE_TYPE, ROUTINE_NAME, DTD_IDENTIFIER, ROUTINE_DEFINITION \
               FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? \
               ORDER BY ROUTINE_TYPE, ROUTINE_NAME";
    ctx.log(sql);
    let rows = timeout(
        SCHEMA_TIMEOUT,
        sqlx::query(sql).bind(database).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    for r in &rows {
        let rtype: String = r.try_get("ROUTINE_TYPE").unwrap_or_default();
        let body: Option<String> = r.try_get("ROUTINE_DEFINITION").unwrap_or_default();
        let returns: Option<String> = r.try_get("DTD_IDENTIFIER").unwrap_or_default();
        out.push(RoutineInfo {
            kind: if rtype == "FUNCTION" {
                "関数".to_string()
            } else {
                "プロシージャ".to_string()
            },
            schema: String::new(),
            name: r.try_get("ROUTINE_NAME").unwrap_or_default(),
            detail: returns
                .filter(|s| !s.is_empty())
                .map(|s| format!("戻り値: {s}"))
                .unwrap_or_default(),
            // information_schema が返すのは本体だけなので、
            // 何の定義か分かるように見出しを付ける
            definition: match body.filter(|s| !s.trim().is_empty()) {
                Some(b) => format!(
                    "-- {} {}\n{b}",
                    rtype,
                    r.try_get::<String, _>("ROUTINE_NAME").unwrap_or_default()
                ),
                None => NO_DEFINITION.to_string(),
            },
        });
    }

    let sql = "SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, \
                      ACTION_TIMING, ACTION_STATEMENT \
               FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? \
               ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME";
    ctx.log(sql);
    let rows = timeout(
        SCHEMA_TIMEOUT,
        sqlx::query(sql).bind(database).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    for r in &rows {
        let table: String = r.try_get("EVENT_OBJECT_TABLE").unwrap_or_default();
        let timing: String = r.try_get("ACTION_TIMING").unwrap_or_default();
        let event: String = r.try_get("EVENT_MANIPULATION").unwrap_or_default();
        let body: Option<String> = r.try_get("ACTION_STATEMENT").unwrap_or_default();
        let name: String = r.try_get("TRIGGER_NAME").unwrap_or_default();
        out.push(RoutineInfo {
            kind: "トリガ".to_string(),
            schema: String::new(),
            name: name.clone(),
            detail: format!("{table} / {timing} {event}"),
            // information_schema が返すのは本体だけなので見出しを付ける
            definition: match body.filter(|s| !s.trim().is_empty()) {
                Some(b) => format!("-- TRIGGER {name} ({timing} {event} ON {table})\n{b}"),
                None => NO_DEFINITION.to_string(),
            },
        });
    }
    Ok(out)
}

/// PostgreSQL: 関数・プロシージャ・トリガの定義
pub async fn pg_routines(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<RoutineInfo>, String> {
    let mut out = Vec::new();

    // pg_get_functiondef はCREATE文をそのまま返す (集約関数では使えないので除く)
    let sql = "SELECT n.nspname AS schema, p.proname AS name, \
                      pg_get_function_identity_arguments(p.oid) AS args, \
                      p.prokind AS kind, \
                      CASE WHEN p.prokind IN ('f', 'p') \
                           THEN pg_get_functiondef(p.oid) ELSE NULL END AS def \
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
               WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') \
                 AND n.nspname = ANY (current_schemas(false)) \
                 AND p.oid NOT IN (SELECT objid FROM pg_depend \
                                   WHERE classid = 'pg_proc'::regclass \
                                     AND deptype = 'e') \
               ORDER BY n.nspname, p.proname \
               LIMIT 500";
    ctx.log(sql);
    let rows = timeout(SCHEMA_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
    for r in &rows {
        let kind: String = r
            .try_get::<Option<i8>, _>("kind")
            .unwrap_or_default()
            .map(|c| (c as u8 as char).to_string())
            .unwrap_or_default();
        let args: String = r.try_get("args").unwrap_or_default();
        let def: Option<String> = r.try_get("def").unwrap_or_default();
        out.push(RoutineInfo {
            kind: match kind.as_str() {
                "p" => "プロシージャ".to_string(),
                "a" => "集約関数".to_string(),
                "w" => "ウィンドウ関数".to_string(),
                _ => "関数".to_string(),
            },
            schema: r.try_get("schema").unwrap_or_default(),
            name: r.try_get("name").unwrap_or_default(),
            detail: if args.is_empty() {
                String::new()
            } else {
                format!("({args})")
            },
            definition: def
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| NO_DEFINITION.to_string()),
        });
    }

    let sql = "SELECT n.nspname AS schema, t.tgname AS name, c.relname AS tbl, \
                      pg_get_triggerdef(t.oid) AS def \
               FROM pg_trigger t \
               JOIN pg_class c ON c.oid = t.tgrelid \
               JOIN pg_namespace n ON n.oid = c.relnamespace \
               WHERE NOT t.tgisinternal \
                 AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
                 AND n.nspname = ANY (current_schemas(false)) \
               ORDER BY n.nspname, c.relname, t.tgname \
               LIMIT 500";
    ctx.log(sql);
    let rows = timeout(SCHEMA_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
    for r in &rows {
        let def: Option<String> = r.try_get("def").unwrap_or_default();
        out.push(RoutineInfo {
            kind: "トリガ".to_string(),
            schema: r.try_get("schema").unwrap_or_default(),
            name: r.try_get("name").unwrap_or_default(),
            detail: r.try_get("tbl").unwrap_or_default(),
            definition: def
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| NO_DEFINITION.to_string()),
        });
    }
    Ok(out)
}

/// SQLite: トリガの定義 (関数・プロシージャは持たない)
pub async fn sqlite_routines(
    conn: &mut SqliteConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<RoutineInfo>, String> {
    let sql = "SELECT name, tbl_name, sql FROM sqlite_master \
               WHERE type = 'trigger' ORDER BY tbl_name, name";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
    Ok(rows
        .iter()
        .map(|r| {
            let def: Option<String> = r.try_get("sql").unwrap_or_default();
            RoutineInfo {
                kind: "トリガ".to_string(),
                schema: String::new(),
                name: r.try_get("name").unwrap_or_default(),
                detail: r.try_get("tbl_name").unwrap_or_default(),
                definition: def
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| NO_DEFINITION.to_string()),
            }
        })
        .collect())
}

/// MySQL: 1テーブルの外部キー (制約名・複合キー・動作つき)
pub async fn mysql_foreign_key_defs(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let sql = "SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, \
                      k.REFERENCED_TABLE_SCHEMA AS ref_schema, \
                      k.REFERENCED_TABLE_NAME AS ref_table, \
                      k.REFERENCED_COLUMN_NAME AS ref_col, \
                      r.DELETE_RULE AS on_delete, r.UPDATE_RULE AS on_update \
               FROM information_schema.KEY_COLUMN_USAGE k \
               JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
                 ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA \
                AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
               WHERE k.CONSTRAINT_SCHEMA = ? AND k.TABLE_NAME = ? \
                 AND k.REFERENCED_TABLE_NAME IS NOT NULL \
               ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION";
    ctx.log(sql);
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(database).bind(table).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;

    let mut out: Vec<ForeignKeyInfo> = Vec::new();
    for r in &rows {
        let name: String = r.try_get("name").unwrap_or_default();
        let col: String = r.try_get("col").unwrap_or_default();
        let ref_col: String = r.try_get("ref_col").unwrap_or_default();
        // 複合キーは行が分かれて返るので、制約名でまとめる
        match out.last_mut().filter(|f| f.name == name) {
            Some(f) => {
                f.columns.push(col);
                f.ref_columns.push(ref_col);
            }
            None => {
                // 別のDBを参照している場合だけ、DB名も出す
                let ref_schema: String = r.try_get("ref_schema").unwrap_or_default();
                out.push(ForeignKeyInfo {
                    name,
                    columns: vec![col],
                    ref_schema: if ref_schema == database {
                        String::new()
                    } else {
                        ref_schema
                    },
                    ref_table: r.try_get("ref_table").unwrap_or_default(),
                    ref_columns: vec![ref_col],
                    on_delete: r.try_get("on_delete").unwrap_or_default(),
                    on_update: r.try_get("on_update").unwrap_or_default(),
                })
            }
        }
    }
    Ok(out)
}

/// PostgreSQL: 1テーブルの外部キー
pub async fn pg_foreign_key_defs(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let sql = "SELECT con.conname AS name, \
                      rn.nspname AS ref_schema, rc.relname AS ref_table, \
                      con.confdeltype AS del, con.confupdtype AS upd, \
                      ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) \
                            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum \
                            ORDER BY k.ord) AS cols, \
                      ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord) \
                            JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum \
                            ORDER BY k.ord) AS ref_cols \
               FROM pg_constraint con \
               JOIN pg_class c ON c.oid = con.conrelid \
               JOIN pg_namespace n ON n.oid = c.relnamespace \
               JOIN pg_class rc ON rc.oid = con.confrelid \
               JOIN pg_namespace rn ON rn.oid = rc.relnamespace \
               WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2 \
               ORDER BY con.conname";
    ctx.log(sql);
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(schema).bind(table).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;

    rows.iter()
        .map(|r| {
            // カラムが読めないまま「カラム0本の外部キー」を出すと
            // 画面では気づけないので、ここでエラーにする
            Ok(ForeignKeyInfo {
                name: r.try_get("name").map_err(format_db_error)?,
                columns: r.try_get("cols").map_err(format_db_error)?,
                // 同じスキーマなら省いて読みやすくする (MySQL側と同じ扱い)
            ref_schema: match r.try_get::<String, _>("ref_schema") {
                Ok(ns) if ns == schema => String::new(),
                Ok(ns) => ns,
                Err(e) => return Err(format_db_error(e)),
            },
                ref_table: r.try_get("ref_table").map_err(format_db_error)?,
                ref_columns: r.try_get("ref_cols").map_err(format_db_error)?,
                on_delete: pg_fk_action(r.try_get("del").unwrap_or(b'a' as i8)),
                on_update: pg_fk_action(r.try_get("upd").unwrap_or(b'a' as i8)),
            })
        })
        .collect()
}

/// PostgreSQLの外部キー動作コードを言葉に直す (a = 既定の NO ACTION)
fn pg_fk_action(code: i8) -> String {
    match code as u8 as char {
        'r' => "RESTRICT".to_string(),
        'c' => "CASCADE".to_string(),
        'n' => "SET NULL".to_string(),
        'd' => "SET DEFAULT".to_string(),
        _ => String::new(),
    }
}

/// SQLite: 1テーブルの外部キー (PRAGMA foreign_key_list)
pub async fn sqlite_foreign_key_defs(
    conn: &mut SqliteConnection,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<ForeignKeyInfo>, String> {
    // pragma_foreign_key_list は表として読めるので、名前をそのまま渡せる
    let sql = "SELECT id, seq, \"table\", \"from\", \"to\", on_update, on_delete \
               FROM pragma_foreign_key_list(?) ORDER BY id, seq";
    ctx.log(sql);
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(table).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?
    .map_err(format_db_error)?;

    let mut out: Vec<ForeignKeyInfo> = Vec::new();
    for r in &rows {
        let id: i64 = r.try_get("id").unwrap_or_default();
        let col: String = r.try_get("from").unwrap_or_default();
        // REFERENCES parent (列を省略) のときは to がNULLになる。
        // 参照先は相手の主キーなので、そうと分かる書き方にする
        let ref_col: String = r
            .try_get::<Option<String>, _>("to")
            .unwrap_or_default()
            .unwrap_or_else(|| "(主キー)".to_string());
        // SQLiteに制約名は無いので、通し番号で見分ける
        let name = format!("fk_{id}");
        match out.last_mut().filter(|f| f.name == name) {
            Some(f) => {
                f.columns.push(col);
                f.ref_columns.push(ref_col);
            }
            None => out.push(ForeignKeyInfo {
                name,
                columns: vec![col],
                ref_schema: String::new(),
                ref_table: r.try_get("table").unwrap_or_default(),
                ref_columns: vec![ref_col],
                on_delete: r.try_get("on_delete").unwrap_or_default(),
                on_update: r.try_get("on_update").unwrap_or_default(),
            }),
        }
    }
    Ok(out)
}

// ---------- 実行中の接続・クエリ (プロセス一覧) ----------

/// サーバー側の接続1本ぶんの情報
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    /// 接続ID (MySQL) / プロセスID (PostgreSQL)。中止・切断に使う
    pub id: i64,
    pub user: String,
    /// 接続元 (host:port など)
    pub host: String,
    /// 接続先のデータベース名
    pub database: String,
    /// 状態 (Sleep / Query / active / idle in transaction など)
    pub state: String,
    /// その状態になってからの秒数 (取れなければ0)
    pub seconds: i64,
    /// 実行中のSQL (空なら何も走っていない)
    pub query: String,
    /// この画面自身の接続か (自分を切らないよう目印にする)
    pub is_self: bool,
}

/// MySQL: 実行中の接続一覧 (PROCESS権限が無いと自分のぶんしか見えない)
pub async fn mysql_processes(
    conn: &mut MySqlConnection,
    ctx: &LogCtx<'_>,
    log: bool,
) -> Result<Vec<ProcessInfo>, String> {
    // information_schema.PROCESSLIST は 8.0.22 で非推奨になったため
    // どのバージョンでも使える SHOW FULL PROCESSLIST を使う
    let sql = "SHOW FULL PROCESSLIST";
    if log {
        ctx.log(sql);
    }
    /*
     * 自分の接続IDが取れないときは、全部「自分かもしれない」扱いにする。
     * 分からないまま「他人だ」と言い切ると、自分の接続を切る操作を出してしまう
     */
    let me = sqlx::query_scalar::<_, i64>("SELECT CAST(CONNECTION_ID() AS SIGNED)")
        .fetch_one(&mut *conn)
        .await
        .ok();
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        // IDは環境によって符号なし整数で返るため、両方の型で受ける
        let id = r
            .try_get::<i64, _>("Id")
            .or_else(|_| r.try_get::<u64, _>("Id").map(|v| v as i64))
            .unwrap_or(0);
        let command: String = r.try_get("Command").unwrap_or_default();
        let state: String = r.try_get("State").unwrap_or_default();
        out.push(ProcessInfo {
            id,
            user: r.try_get("User").unwrap_or_default(),
            host: r.try_get("Host").unwrap_or_default(),
            database: r.try_get("db").unwrap_or_default(),
            // Commandが主、Stateは補足 (例: "Query / Sending data")
            state: if state.is_empty() {
                command
            } else {
                format!("{command} / {state}")
            },
            seconds: r
                .try_get::<i64, _>("Time")
                .or_else(|_| r.try_get::<u64, _>("Time").map(|v| v as i64))
                .unwrap_or(0),
            query: r.try_get("Info").unwrap_or_default(),
            is_self: me.is_none_or(|m| m == id),
        });
    }
    Ok(out)
}

/// PostgreSQL: 実行中の接続一覧 (他ユーザーのSQL本文は権限が無いと見えない)
pub async fn pg_processes(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
    log: bool,
) -> Result<Vec<ProcessInfo>, String> {
    let select = "SELECT pid, \
               COALESCE(usename, '') AS usename, \
               COALESCE(host(client_addr) || ':' || client_port::text, '') AS client, \
               COALESCE(datname, '') AS datname, \
               COALESCE(state, '') AS state, \
               COALESCE(EXTRACT(EPOCH FROM (now() - state_change))::bigint, 0) AS secs, \
               COALESCE(query, '') AS query, \
               pid = pg_backend_pid() AS is_self \
               FROM pg_stat_activity";
    let order = " ORDER BY state = 'active' DESC, secs DESC";
    // 内部プロセス (autovacuum等) は操作対象にならないので除く。
    // backend_type は PostgreSQL 10 以降にしか無いので、
    // 弾かれたらこの条件を外して取り直す
    let sql = format!("{select} WHERE backend_type = 'client backend'{order}");
    if log {
        ctx.log(&sql);
    }
    let first = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sqlx::AssertSqlSafe(sql.clone())).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "クエリがタイムアウトしました".to_string())?;
    let rows = match first {
        Ok(rows) => rows,
        Err(_) => {
            let sql = format!("{select} WHERE datname IS NOT NULL{order}");
            if log {
                ctx.log(&sql);
            }
            timeout(
                QUERY_TIMEOUT,
                sqlx::query(sqlx::AssertSqlSafe(sql)).fetch_all(&mut *conn),
            )
            .await
            .map_err(|_| "クエリがタイムアウトしました".to_string())?
            .map_err(format_db_error)?
        }
    };
    Ok(rows
        .iter()
        .map(|r| ProcessInfo {
            id: r.try_get::<i32, _>("pid").unwrap_or(0) as i64,
            user: r.try_get("usename").unwrap_or_default(),
            host: r.try_get("client").unwrap_or_default(),
            database: r.try_get("datname").unwrap_or_default(),
            state: r.try_get("state").unwrap_or_default(),
            seconds: r.try_get("secs").unwrap_or(0),
            query: r.try_get("query").unwrap_or_default(),
            // 分からないときは「自分かもしれない」に倒して操作させない
            is_self: r.try_get("is_self").unwrap_or(true),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /*
     * ここで使う値は、実際の PostgreSQL 16 に問い合わせて確かめたもの:
     *   pg_get_partkeydef  → "RANGE (at)"
     *   pg_get_expr(relpartbound, oid)
     *       → "FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')" / "DEFAULT"
     */

    #[test]
    fn パーティションの親には分け方を付ける() {
        let lines = vec![
            "    \"id\" bigint NOT NULL".to_string(),
            "    \"at\" date NOT NULL".to_string(),
        ];
        let sql = pg_create_table("\"public\".\"sales\"", &lines, Some("RANGE (at)"));
        assert_eq!(
            sql,
            "CREATE TABLE \"public\".\"sales\" (\n\
             \x20   \"id\" bigint NOT NULL,\n\
             \x20   \"at\" date NOT NULL\n\
             )\nPARTITION BY RANGE (at);"
        );
        // 分かれていないテーブルには付かない
        let plain = pg_create_table("\"public\".\"t\"", &lines, None);
        assert!(!plain.contains("PARTITION BY"), "{plain}");
        assert!(plain.ends_with(");"), "{plain}");
    }

    #[test]
    fn パーティションの子は列を並べ直さない() {
        // 列は親から引き継ぐので、CREATE TABLE … PARTITION OF が本来の形
        let sql = pg_partition_of(
            "\"public\".\"sales_2024_01\"",
            "\"public\".\"sales\"",
            "FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')",
            None,
        );
        assert_eq!(
            sql,
            "CREATE TABLE \"public\".\"sales_2024_01\" PARTITION OF \"public\".\"sales\"\n\
             \x20   FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');"
        );
    }

    #[test]
    fn 既定のパーティションと入れ子も書ける() {
        // 受け皿のパーティションは bound が "DEFAULT" で返る
        let sql = pg_partition_of("\"t\"", "\"p\"", "DEFAULT", None);
        assert!(sql.ends_with("PARTITION OF \"p\"\n    DEFAULT;"), "{sql}");

        // 子がさらに分かれている場合は両方書く
        let nested = pg_partition_of("\"t\"", "\"p\"", "FOR VALUES IN ('a')", Some("HASH (id)"));
        assert!(nested.contains("PARTITION OF \"p\""), "{nested}");
        assert!(nested.ends_with("PARTITION BY HASH (id);"), "{nested}");
    }
}
