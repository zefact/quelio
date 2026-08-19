//! データベース・テーブル一覧を取得するカタログクエリ

use serde::Serialize;
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
        let is_primary = name == "PRIMARY";
        indexes.push(IndexInfo {
            name,
            unique: r
                .try_get::<i64, _>("NON_UNIQUE")
                .map_err(format_db_error)?
                == 0,
            columns: column,
            index_type: r.try_get("INDEX_TYPE").map_err(format_db_error)?,
            cardinality: r.try_get("CARDINALITY").map_err(format_db_error)?,
            // MySQLの主キーは常に PRIMARY という名前のインデックスになる
            constrained: is_primary,
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
                    (ix.indisprimary OR con.oid IS NOT NULL) AS constrained, \
                    pg_get_indexdef(ix.indexrelid) AS definition \
             FROM pg_index ix \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             LEFT JOIN pg_am am ON am.oid = i.relam \
             LEFT JOIN pg_constraint con ON con.conindid = i.oid \
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
            constrained: r.try_get("constrained").map_err(format_db_error)?,
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
