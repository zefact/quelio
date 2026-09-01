//! MySQL のカタログ問い合わせ (一覧・定義・外部キー・ルーチン・接続一覧)

use super::*;

/// MySQL: ログを残してから問い合わせ、全行を返す
async fn mysql_rows(
    conn: &mut MySqlConnection,
    sql: &str,
    binds: &[&str],
    limit: Duration,
    ctx: &LogCtx<'_>,
) -> Result<Vec<sqlx::mysql::MySqlRow>, AppError> {
    ctx.log(&fill_binds(sql, binds, false));
    // SQLはここで組み立てた固定の形 (値はすべてプレースホルダ) なので安全
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.to_string()));
    for b in binds {
        q = q.bind(b.to_string());
    }
    timeout(limit, q.fetch_all(&mut *conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)
}

/// MySQL: カラム一覧のSQL
pub(super) fn mysql_columns_sql(scope: Scope) -> String {
    let (name_col, more, order) = match scope {
        Scope::One => ("", " AND TABLE_NAME = ?", ""),
        Scope::All => ("TABLE_NAME, ", "", "TABLE_NAME, "),
    };
    format!(
        "SELECT {name_col}COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, \
                    COLUMN_DEFAULT, EXTRA, COLLATION_NAME, COLUMN_COMMENT \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ?{more} \
             ORDER BY {order}ORDINAL_POSITION"
    )
}

/// MySQL: インデックス一覧のSQL。
///
/// EXPRESSION列は関数(式)インデックスの式 (MySQL 8.0.13以降)。
/// 古いサーバーには無いので、失敗したら付けずに取り直す。
/// 並び順は主キー(PRIMARY)を先頭に固定し、残りはインデックス名順。
/// 各インデックス内のカラムはSEQ_IN_INDEX順 (複合インデックスの定義順)
pub(super) fn mysql_indexes_sql(scope: Scope, expression: bool) -> String {
    let (name_col, more, order) = match scope {
        Scope::One => ("", " AND TABLE_NAME = ?", ""),
        Scope::All => ("TABLE_NAME, ", "", "TABLE_NAME, "),
    };
    let expr = if expression { "EXPRESSION, " } else { "" };
    format!(
        "SELECT {name_col}INDEX_NAME, CAST(NON_UNIQUE AS SIGNED) AS NON_UNIQUE, \
                    COLUMN_NAME, {expr}INDEX_TYPE, \
                    CAST(SUB_PART AS SIGNED) AS SUB_PART, \
                    CAST(CARDINALITY AS SIGNED) AS CARDINALITY \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ?{more} \
             ORDER BY {order}(INDEX_NAME = 'PRIMARY') DESC, INDEX_NAME, SEQ_IN_INDEX"
    )
}

/// MySQL: テーブル情報 (エンジン・行数・サイズなど) のSQL
fn mysql_table_info_sql(scope: Scope) -> String {
    let (name_col, more) = match scope {
        Scope::One => ("", " AND T.TABLE_NAME = ?"),
        Scope::All => ("T.TABLE_NAME, ", ""),
    };
    format!(
        "SELECT {name_col}T.ENGINE, CAST(T.TABLE_ROWS AS SIGNED) AS TABLE_ROWS, \
                    CAST(T.DATA_LENGTH + IFNULL(T.INDEX_LENGTH, 0) AS SIGNED) AS TOTAL_SIZE, \
                    CAST(T.AUTO_INCREMENT AS SIGNED) AS AUTO_INC, \
                    CCSA.CHARACTER_SET_NAME AS CHARSET, \
                    T.TABLE_COLLATION, CAST(T.CREATE_TIME AS CHAR) AS CREATED, \
                    CAST(T.UPDATE_TIME AS CHAR) AS UPDATED, T.TABLE_COMMENT \
             FROM information_schema.TABLES T \
             LEFT JOIN information_schema.COLLATION_CHARACTER_SET_APPLICABILITY CCSA \
               ON CCSA.COLLATION_NAME = T.TABLE_COLLATION \
             WHERE T.TABLE_SCHEMA = ?{more}"
    )
}

/// MySQL: インデックスを取る。
/// 戻り値の bool は「EXPRESSION列を取れたか」(式インデックスの表示に使う)
async fn mysql_index_rows(
    conn: &mut MySqlConnection,
    scope: Scope,
    binds: &[&str],
    limit: Duration,
    ctx: &LogCtx<'_>,
) -> Result<(Vec<sqlx::mysql::MySqlRow>, bool), AppError> {
    match mysql_rows(conn, &mysql_indexes_sql(scope, true), binds, limit, ctx).await {
        Ok(rows) => Ok((rows, true)),
        // 古いサーバー (EXPRESSION が無い) では付けずに取り直す
        Err(_) => {
            let sql = mysql_indexes_sql(scope, false);
            Ok((mysql_rows(conn, &sql, binds, limit, ctx).await?, false))
        }
    }
}

/// MySQL: バージョン・デフォルト文字コード・照合順序など
pub async fn mysql_server_info(
    conn: &mut MySqlConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<(String, String)>, AppError> {
    let sql = "SELECT @@version AS version, \
               @@character_set_server AS charset, @@collation_server AS collation, \
               @@system_time_zone AS tz";
    ctx.log(sql);
    let row = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_one(conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;

    let version: String = row.try_get("version").map_err(db_error)?;
    let charset: String = row.try_get("charset").map_err(db_error)?;
    let collation: String = row.try_get("collation").map_err(db_error)?;
    let tz: Option<String> = row.try_get("tz").map_err(db_error)?;

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

/// MySQL: 文字コードと照合順序の一覧。
///
/// 画面で選べるようにするために取る。
/// 手で打たせると綴り違いでエラーになるし、
/// どの照合順序がどの文字コードのものかも分からない
pub async fn mysql_charsets(
    conn: &mut MySqlConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<CharsetInfo>, AppError> {
    let sql = "SHOW CHARACTER SET";
    ctx.log(sql);
    let sets = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;

    let sql = "SHOW COLLATION";
    ctx.log(sql);
    let colls = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;

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

pub async fn mysql_databases(
    conn: &mut MySqlConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<String>, AppError> {
    let sql = "SHOW DATABASES";
    ctx.log(sql);
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query_scalar::<_, String>(sql).fetch_all(conn),
    )
    .await
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;
    Ok(rows)
}

pub async fn mysql_tables(
    conn: &mut MySqlConnection,
    schema: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<TableInfo>, AppError> {
    let sql = "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS \
               FROM information_schema.TABLES \
               WHERE TABLE_SCHEMA = ? \
               ORDER BY TABLE_NAME";
    ctx.log(&sql.replace('?', &format!("'{schema}'")));
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).bind(schema).fetch_all(conn))
    .await
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;

    rows.iter()
        .map(|row| {
            Ok(TableInfo {
                schema: None,
                name: row.try_get("TABLE_NAME").map_err(db_error)?,
                table_type: row.try_get("TABLE_TYPE").map_err(db_error)?,
                row_estimate: row
                    .try_get::<Option<u64>, _>("TABLE_ROWS")
                    .map_err(db_error)?
                    .map(|n| n as i64),
                // パーティションはPostgreSQLだけ扱う
                partition_by: None,
                partition_of: None,
            })
        })
        .collect()
}

/// MySQL: information_schema.COLUMNS の1行 → カラム情報
fn mysql_column(r: &sqlx::mysql::MySqlRow) -> Result<ColumnInfo, AppError> {
    Ok(ColumnInfo {
        name: r.try_get("COLUMN_NAME").map_err(db_error)?,
        col_type: r.try_get("COLUMN_TYPE").map_err(db_error)?,
        nullable: r
            .try_get::<String, _>("IS_NULLABLE")
            .map_err(db_error)?
            == "YES",
        key: opt(r.try_get("COLUMN_KEY").map_err(db_error)?),
        default: r.try_get("COLUMN_DEFAULT").map_err(db_error)?,
        extra: opt(r.try_get("EXTRA").map_err(db_error)?),
        collation: r.try_get("COLLATION_NAME").map_err(db_error)?,
        comment: opt(r.try_get("COLUMN_COMMENT").map_err(db_error)?),
    })
}

/// MySQL: information_schema.STATISTICS の1行をインデックス一覧へ足す。
/// 同じインデックス名が続く間は、複合インデックスとしてカラムを連結する
fn mysql_push_index(
    indexes: &mut Vec<IndexInfo>,
    r: &sqlx::mysql::MySqlRow,
    has_expression: bool,
) -> Result<(), AppError> {
    let name: String = r.try_get("INDEX_NAME").map_err(db_error)?;
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
        .map_err(db_error)?
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
            .map_err(db_error)?
            == 0,
        columns: column,
        sub_parts: vec![prefix],
        index_type: r.try_get("INDEX_TYPE").map_err(db_error)?,
        cardinality: r.try_get("CARDINALITY").map_err(db_error)?,
        // MySQLの主キーは常に PRIMARY という名前のインデックスになる
        constrained: is_primary,
    });
    Ok(())
}

/// MySQL: information_schema.TABLES の1行 → 画面に出すテーブル情報
fn mysql_table_info(r: &sqlx::mysql::MySqlRow) -> Result<Vec<(String, String)>, AppError> {
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
        if let Some(v) = opt(r.try_get(col).map_err(db_error)?) {
            info.push((label.to_string(), v));
        } else if label == "更新" {
            // InnoDBはサーバー再起動後などにUPDATE_TIMEがNULLになるため "-" で明示する
            info.push((label.to_string(), "-".to_string()));
        }
    }
    if let Some(n) = r
        .try_get::<Option<i64>, _>("TABLE_ROWS")
        .map_err(db_error)?
    {
        info.insert(1.min(info.len()), ("概算行数".into(), n.to_string()));
    }
    if let Some(n) = r
        .try_get::<Option<i64>, _>("TOTAL_SIZE")
        .map_err(db_error)?
    {
        info.insert(2.min(info.len()), ("サイズ".into(), format_bytes(n)));
    }
    // AUTO_INCREMENTを持つテーブルのみ表示 (値は次に採番される番号)
    if let Some(n) = r
        .try_get::<Option<i64>, _>("AUTO_INC")
        .map_err(db_error)?
    {
        info.insert(3.min(info.len()), ("AUTO_INCREMENT".into(), n.to_string()));
    }
    Ok(info)
}

/// MySQL: テーブル構造(カラム・インデックス・情報)を取得
pub async fn mysql_table_detail(
    conn: &mut MySqlConnection,
    schema: &str,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<TableDetail, AppError> {
    // カラム
    let binds = [schema, table];
    let rows = mysql_rows(
        conn,
        &mysql_columns_sql(Scope::One),
        &binds,
        QUERY_TIMEOUT,
        ctx,
    )
    .await?;

    let mut columns = Vec::with_capacity(rows.len());
    for r in &rows {
        columns.push(mysql_column(r)?);
    }

    // インデックス (カラムを1行にまとめる)
    let (rows, has_expression) =
        mysql_index_rows(conn, Scope::One, &binds, QUERY_TIMEOUT, ctx).await?;

    let mut indexes: Vec<IndexInfo> = Vec::new();
    for r in &rows {
        mysql_push_index(&mut indexes, r, has_expression)?;
    }

    // テーブル情報
    let rows = mysql_rows(
        conn,
        &mysql_table_info_sql(Scope::One),
        &binds,
        QUERY_TIMEOUT,
        ctx,
    )
    .await?;
    let info = match rows.first() {
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
) -> Result<Vec<FkInfo>, AppError> {
    let sql = "SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY TABLE_NAME, ORDINAL_POSITION";
    ctx.log(&sql.replace('?', &format!("'{schema}'")));
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).bind(schema).fetch_all(conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;

    rows.iter()
        .map(|r| {
            Ok(FkInfo {
                table: r.try_get("TABLE_NAME").map_err(db_error)?,
                column: r.try_get("COLUMN_NAME").map_err(db_error)?,
                ref_table: r
                    .try_get("REFERENCED_TABLE_NAME")
                    .map_err(db_error)?,
                ref_column: r
                    .try_get("REFERENCED_COLUMN_NAME")
                    .map_err(db_error)?,
            })
        })
        .collect()
}

/// MySQL: 補完用のテーブル・カラム一覧
pub async fn mysql_schema_columns(
    conn: &mut MySqlConnection,
    database: &str,
    ctx: &LogCtx<'_>,
) -> Result<SchemaColumns, AppError> {
    // ビューのTABLE_COMMENTは 'VIEW' が入るだけなので、日本語名としては使わない
    let sql = "SELECT c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE, c.COLUMN_COMMENT, \
                    c.COLUMN_KEY, \
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;
    let pairs = rows
        .iter()
        .map(|r| {
            Ok((
                r.try_get::<String, _>("TABLE_NAME").map_err(db_error)?,
                r.try_get::<String, _>("TBL_COMMENT").map_err(db_error)?,
                SchemaColumn {
                    name: r
                        .try_get::<String, _>("COLUMN_NAME")
                        .map_err(db_error)?,
                    data_type: r
                        .try_get::<String, _>("COLUMN_TYPE")
                        .map_err(db_error)?,
                    comment: r
                        .try_get::<String, _>("COLUMN_COMMENT")
                        .map_err(db_error)?,
                    // 主キーは COLUMN_KEY が 'PRI' (複合キーでも各列に付く)。
                    // 補完が丸ごと止まるのは惜しいので、読めない場合は主キー無しとして扱う
                    pk: r
                        .try_get::<Option<String>, _>("COLUMN_KEY")
                        .unwrap_or_default()
                        .as_deref()
                        == Some("PRI"),
                },
            ))
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    Ok(group_columns(pairs))
}

/// MySQL: 使える照合順序の一覧 (よく使うutf8mb4を先頭にまとめる)
pub async fn mysql_collations(
    conn: &mut MySqlConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<String>, AppError> {
    let sql = "SELECT COLLATION_NAME FROM information_schema.COLLATIONS \
             ORDER BY (CHARACTER_SET_NAME = 'utf8mb4') DESC, \
                      CHARACTER_SET_NAME, COLLATION_NAME";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;
    rows.iter()
        .map(|r| {
            r.try_get::<Option<String>, _>("COLLATION_NAME")
                .map_err(db_error)
                .map(|v| v.unwrap_or_default())
        })
        .collect::<Result<Vec<_>, AppError>>()
        .map(|v| v.into_iter().filter(|s| !s.is_empty()).collect())
}

/// MySQL: 指定DBの全テーブルの定義 (テーブル名 → 定義)
pub async fn mysql_schema_details(
    conn: &mut MySqlConnection,
    database: &str,
    ctx: &LogCtx<'_>,
) -> Result<HashMap<String, TableDetail>, AppError> {
    let mut out: HashMap<String, TableDetail> = HashMap::new();

    // カラム
    let binds = [database];
    let rows = mysql_rows(
        conn,
        &mysql_columns_sql(Scope::All),
        &binds,
        SCHEMA_TIMEOUT,
        ctx,
    )
    .await?;
    for r in &rows {
        let table: String = r.try_get("TABLE_NAME").map_err(db_error)?;
        out.entry(table).or_default().columns.push(mysql_column(r)?);
    }

    // インデックス
    let (rows, has_expression) =
        mysql_index_rows(conn, Scope::All, &binds, SCHEMA_TIMEOUT, ctx).await?;
    for r in &rows {
        let table: String = r.try_get("TABLE_NAME").map_err(db_error)?;
        let d = out.entry(table).or_default();
        mysql_push_index(&mut d.indexes, r, has_expression)?;
    }

    // テーブル情報
    let rows = mysql_rows(
        conn,
        &mysql_table_info_sql(Scope::All),
        &binds,
        SCHEMA_TIMEOUT,
        ctx,
    )
    .await?;
    for r in &rows {
        let table: String = r.try_get("TABLE_NAME").map_err(db_error)?;
        out.entry(table).or_default().info = mysql_table_info(r)?;
    }

    Ok(out)
}

/// MySQL: SHOW CREATE TABLE の結果
pub async fn mysql_table_ddl(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<String, AppError> {
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;
    // 2列目が定義 (テーブルは "Create Table"、ビューは "Create View")
    row.try_get::<String, _>(1).map_err(db_error)
}

/// MySQL: 関数・プロシージャ・トリガの定義
pub async fn mysql_routines(
    conn: &mut MySqlConnection,
    database: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<RoutineInfo>, AppError> {
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;
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

/// MySQL: 1テーブルの外部キー (制約名・複合キー・動作つき)
pub async fn mysql_foreign_key_defs(
    conn: &mut MySqlConnection,
    database: &str,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<ForeignKeyInfo>, AppError> {
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;

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

/// MySQL: 実行中の接続一覧 (PROCESS権限が無いと自分のぶんしか見えない)
pub async fn mysql_processes(
    conn: &mut MySqlConnection,
    ctx: &LogCtx<'_>,
    log: bool,
) -> Result<Vec<ProcessInfo>, AppError> {
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
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;
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
