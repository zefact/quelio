//! データベース・テーブル一覧を取得するカタログクエリ

use sqlx::mysql::MySqlConnection;
use sqlx::postgres::PgConnection;
use sqlx::sqlite::SqliteConnection;
use sqlx::Row;
use tokio::time::{timeout, Duration};

use crate::db::format_db_error;
use crate::models::{ColumnInfo, FkInfo, IndexInfo, TableDetail, TableInfo};
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
    // 古いサーバーには存在しないため、失敗したらEXPRESSIONなしで再取得する。
    // 並び順は主キー(PRIMARY)を先頭に固定し、残りはインデックス名順。
    // 各インデックス内のカラムはSEQ_IN_INDEX順 (複合インデックスの定義順)
    let sql_expr = "SELECT INDEX_NAME, CAST(NON_UNIQUE AS SIGNED) AS NON_UNIQUE, \
                    COLUMN_NAME, EXPRESSION, INDEX_TYPE, \
                    CAST(CARDINALITY AS SIGNED) AS CARDINALITY \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY (INDEX_NAME = 'PRIMARY') DESC, INDEX_NAME, SEQ_IN_INDEX";
    let sql_plain = "SELECT INDEX_NAME, CAST(NON_UNIQUE AS SIGNED) AS NON_UNIQUE, \
                    COLUMN_NAME, INDEX_TYPE, \
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

    // インデックス (主キーを先頭に固定し、残りはインデックス名順)
    let sql = "SELECT i.relname AS name, ix.indisunique AS unique_flag, \
                    am.amname AS index_type, \
                    pg_get_indexdef(ix.indexrelid) AS definition \
             FROM pg_index ix \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             LEFT JOIN pg_am am ON am.oid = i.relam \
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
    for r in &rows {
        let notnull: i64 = r.try_get("notnull").map_err(format_db_error)?;
        let pk: i64 = r.try_get("pk").map_err(format_db_error)?;
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
            index_type: Some(match origin.as_str() {
                "pk" => "PRIMARY KEY".to_string(),
                "u" => "UNIQUE制約".to_string(),
                _ if partial != 0 => "部分インデックス".to_string(),
                _ => "INDEX".to_string(),
            }),
            cardinality: None,
        });
    }
    // 主キー由来のインデックスを先頭にする (他DBの表示と揃える)
    indexes.sort_by_key(|i| i.index_type.as_deref() != Some("PRIMARY KEY"));

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

    Ok(TableDetail {
        columns,
        indexes,
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
