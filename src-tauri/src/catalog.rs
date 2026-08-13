//! データベース・テーブル一覧を取得するカタログクエリ

use sqlx::mysql::MySqlConnection;
use sqlx::postgres::PgConnection;
use sqlx::Row;
use tokio::time::{timeout, Duration};

use crate::db::format_db_error;
use crate::models::{ColumnInfo, IndexInfo, TableDetail, TableInfo};
use crate::query_log::QueryLog;

const QUERY_TIMEOUT: Duration = Duration::from_secs(15);

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
            })
        })
        .collect()
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
        columns.push(ColumnInfo {
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
        });
    }

    // インデックス (カラムを1行にまとめる)。
    // EXPRESSION列は関数(式)インデックスの式 (MySQL 8.0.13+)。
    // 古いサーバーには存在しないため、失敗したらEXPRESSIONなしで再取得する
    let sql_expr = "SELECT INDEX_NAME, CAST(NON_UNIQUE AS SIGNED) AS NON_UNIQUE, \
                    COLUMN_NAME, EXPRESSION, INDEX_TYPE, \
                    CAST(CARDINALITY AS SIGNED) AS CARDINALITY \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY INDEX_NAME, SEQ_IN_INDEX";
    let sql_plain = "SELECT INDEX_NAME, CAST(NON_UNIQUE AS SIGNED) AS NON_UNIQUE, \
                    COLUMN_NAME, INDEX_TYPE, \
                    CAST(CARDINALITY AS SIGNED) AS CARDINALITY \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY INDEX_NAME, SEQ_IN_INDEX";
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
        let name: String = r.try_get("INDEX_NAME").map_err(format_db_error)?;
        // 関数(式)インデックスではCOLUMN_NAMEがNULLになり、式はEXPRESSION列に入る
        let column: String = match r
            .try_get::<Option<String>, _>("COLUMN_NAME")
            .map_err(format_db_error)?
        {
            Some(c) => c,
            None => {
                let expr = if has_expression {
                    r.try_get::<Option<String>, _>("EXPRESSION")
                        .ok()
                        .flatten()
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
                continue;
            }
        }
        indexes.push(IndexInfo {
            name,
            unique: r
                .try_get::<i64, _>("NON_UNIQUE")
                .map_err(format_db_error)?
                == 0,
            columns: column,
            index_type: r.try_get("INDEX_TYPE").map_err(format_db_error)?,
            cardinality: r.try_get("CARDINALITY").map_err(format_db_error)?,
        });
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

    let mut info: Vec<(String, String)> = Vec::new();
    if let Some(r) = row {
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
    }

    Ok(TableDetail {
        columns,
        indexes,
        info,
    })
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
                    c.reltuples::bigint AS row_estimate \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
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
            })
        })
        .collect()
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
                    CASE a.attidentity \
                      WHEN 'a' THEN 'identity always' \
                      WHEN 'd' THEN 'identity by default' \
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
        let is_pk: bool = r.try_get("is_pk").map_err(format_db_error)?;
        columns.push(ColumnInfo {
            name: r.try_get("name").map_err(format_db_error)?,
            col_type: r.try_get("col_type").map_err(format_db_error)?,
            nullable: r.try_get("nullable").map_err(format_db_error)?,
            key: is_pk.then(|| "PRI".to_string()),
            default: r.try_get("default_expr").map_err(format_db_error)?,
            extra: opt(r.try_get("extra").map_err(format_db_error)?),
            collation: r.try_get("collation").map_err(format_db_error)?,
            comment: r.try_get("comment").map_err(format_db_error)?,
        });
    }

    // インデックス
    let sql = "SELECT i.relname AS name, ix.indisunique AS unique_flag, \
                    am.amname AS index_type, \
                    pg_get_indexdef(ix.indexrelid) AS definition \
             FROM pg_index ix \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             LEFT JOIN pg_am am ON am.oid = i.relam \
             WHERE n.nspname = $1 AND t.relname = $2 \
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

    let mut indexes = Vec::with_capacity(rows.len());
    for r in &rows {
        // 定義文からカラム部分 "(...)" を抜き出す
        let definition: String = r.try_get("definition").map_err(format_db_error)?;
        let columns_part = definition
            .split_once('(')
            .map(|(_, rest)| rest.trim_end_matches(')').to_string())
            .unwrap_or(definition);
        indexes.push(IndexInfo {
            name: r.try_get("name").map_err(format_db_error)?,
            unique: r.try_get("unique_flag").map_err(format_db_error)?,
            columns: columns_part,
            index_type: r.try_get("index_type").map_err(format_db_error)?,
            cardinality: None,
        });
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

    let mut info: Vec<(String, String)> = Vec::new();
    if let Some(r) = row {
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
    }

    Ok(TableDetail {
        columns,
        indexes,
        info,
    })
}
