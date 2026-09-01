//! PostgreSQL のカタログ問い合わせ (一覧・定義・外部キー・ルーチン・接続一覧)

use super::*;

/// PostgreSQL: ログを残してから問い合わせ、全行を返す
async fn pg_rows(
    conn: &mut PgConnection,
    sql: &str,
    binds: &[&str],
    limit: Duration,
    ctx: &LogCtx<'_>,
) -> Result<Vec<sqlx::postgres::PgRow>, AppError> {
    ctx.log(&fill_binds(sql, binds, true));
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

/// PostgreSQL: カラム一覧のSQL
pub(super) fn pg_columns_sql(scope: Scope) -> String {
    let (name_cols, cond, order) = match scope {
        Scope::One => ("", "n.nspname = $1 AND c.relname = $2", "a.attnum"),
        Scope::All => (
            "n.nspname AS schema, c.relname AS tbl, ",
            "c.relkind IN ('r', 'p', 'v', 'm', 'f') \
               AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
               AND NOT n.nspname LIKE 'pg_toast%'",
            "n.nspname, c.relname, a.attnum",
        ),
    };
    format!(
        "SELECT {name_cols}a.attname AS name, \
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
               AND {cond} \
             ORDER BY {order}"
    )
}

/// PostgreSQL: インデックス一覧のSQL (主キーを先頭に固定し、残りは名前順)
pub(super) fn pg_indexes_sql(scope: Scope) -> String {
    let (name_cols, cond, order) = match scope {
        Scope::One => (
            "",
            "n.nspname = $1 AND t.relname = $2",
            "ix.indisprimary DESC, i.relname",
        ),
        Scope::All => (
            "n.nspname AS schema, t.relname AS tbl, ",
            "n.nspname NOT IN ('pg_catalog', 'information_schema') \
               AND NOT n.nspname LIKE 'pg_toast%'",
            "n.nspname, t.relname, ix.indisprimary DESC, i.relname",
        ),
    };
    format!(
        "SELECT {name_cols}i.relname AS name, ix.indisunique AS unique_flag, \
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
             WHERE {cond} \
             ORDER BY {order}"
    )
}

/// PostgreSQL: バージョン・エンコーディング・照合順序など
pub async fn pg_server_info(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<(String, String)>, AppError> {
    let sql = "SELECT current_setting('server_version') AS version, \
                      pg_encoding_to_char(d.encoding) AS encoding, \
                      d.datcollate AS collation, \
                      current_setting('TimeZone') AS tz \
               FROM pg_database d WHERE d.datname = current_database()";
    ctx.log(sql);
    let row = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_one(conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;

    let version: String = row.try_get("version").map_err(db_error)?;
    let encoding: String = row.try_get("encoding").map_err(db_error)?;
    let collation: String = row.try_get("collation").map_err(db_error)?;
    let tz: Option<String> = row.try_get("tz").map_err(db_error)?;

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

/// PostgreSQL: 指定できるエンコーディングの一覧。
///
/// サーバーが知っている名前をそのまま聞く (版によって増えるため)
pub async fn pg_encodings(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<CharsetInfo>, AppError> {
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;
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

/// PostgreSQL: pg_attribute の1行 → カラム情報
fn pg_column(r: &sqlx::postgres::PgRow) -> Result<ColumnInfo, AppError> {
    let is_pk: bool = r.try_get("is_pk").map_err(db_error)?;
    Ok(ColumnInfo {
        name: r.try_get("name").map_err(db_error)?,
        col_type: r.try_get("col_type").map_err(db_error)?,
        nullable: r.try_get("nullable").map_err(db_error)?,
        key: is_pk.then(|| "PRI".to_string()),
        default: r.try_get("default_expr").map_err(db_error)?,
        extra: opt(r.try_get("extra").map_err(db_error)?),
        collation: r.try_get("collation").map_err(db_error)?,
        comment: r.try_get("comment").map_err(db_error)?,
    })
}

/// PostgreSQL: pg_index の1行 → インデックス情報
fn pg_index(r: &sqlx::postgres::PgRow) -> Result<IndexInfo, AppError> {
    // 定義文からカラム部分 "(...)" を抜き出す
    let definition: String = r.try_get("definition").map_err(db_error)?;
    let columns_part = definition
        .split_once('(')
        .map(|(_, rest)| rest.trim_end_matches(')').to_string())
        .unwrap_or(definition);
    Ok(IndexInfo {
        name: r.try_get("name").map_err(db_error)?,
        unique: r.try_get("unique_flag").map_err(db_error)?,
        columns: columns_part,
        // 接頭辞インデックスはMySQLだけの仕組み
        sub_parts: Vec::new(),
        index_type: r.try_get("index_type").map_err(db_error)?,
        cardinality: None,
        constrained: r.try_get("constrained").map_err(db_error)?,
    })
}

/// PostgreSQL: pg_class の1行 → 画面に出すテーブル情報
fn pg_table_info(r: &sqlx::postgres::PgRow) -> Result<Vec<(String, String)>, AppError> {
    let mut info: Vec<(String, String)> = Vec::new();
    let estimate: i64 = r.try_get("row_estimate").map_err(db_error)?;
    if estimate >= 0 {
        info.push(("概算行数".into(), estimate.to_string()));
    }
    if let Some(size) = r
        .try_get::<Option<String>, _>("total_size")
        .map_err(db_error)?
    {
        info.push(("サイズ".into(), size));
    }
    if let Some(c) = r
        .try_get::<Option<String>, _>("comment")
        .map_err(db_error)?
    {
        info.push(("コメント".into(), c));
    }
    Ok(info)
}

/// PostgreSQL: 接続中DBの外部キー一覧 (ER図用)
pub async fn pg_foreign_keys(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<FkInfo>, AppError> {
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
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;

    rows.iter()
        .map(|r| {
            Ok(FkInfo {
                table: r.try_get("table_name").map_err(db_error)?,
                column: r.try_get("column_name").map_err(db_error)?,
                ref_table: r.try_get("ref_table").map_err(db_error)?,
                ref_column: r.try_get("ref_column").map_err(db_error)?,
            })
        })
        .collect()
}

pub async fn pg_databases(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<String>, AppError> {
    let sql = "SELECT datname FROM pg_database \
             WHERE datistemplate = false AND datallowconn \
             ORDER BY datname";
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

/// スキーマの一覧 (システムのものは除く)
pub async fn pg_schemas(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<String>, AppError> {
    let sql = "SELECT nspname FROM pg_namespace \
             WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' \
             ORDER BY nspname";
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

/// PostgreSQL: 補完用のテーブル・カラム一覧 (スキーマ付きの名前も入れる)
pub async fn pg_schema_columns(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<SchemaColumns, AppError> {
    let sql = "SELECT n.nspname AS schema, c.relname AS tbl, a.attname AS col, \
                    format_type(a.atttypid, a.atttypmod) AS typ, \
                    COALESCE(col_description(c.oid, a.attnum), '') AS cmt, \
                    COALESCE(obj_description(c.oid, 'pg_class'), '') AS tbl_cmt, \
                    EXISTS ( \
                      SELECT 1 FROM pg_index i \
                      WHERE i.indrelid = c.oid AND i.indisprimary \
                        AND a.attnum = ANY(i.indkey) \
                    ) AS pk \
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
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;

    // 素のテーブル名と "スキーマ.テーブル" の両方で引けるようにする
    let mut plain: Vec<(String, String, SchemaColumn)> = Vec::with_capacity(rows.len());
    let mut qualified: Vec<(String, String, SchemaColumn)> = Vec::with_capacity(rows.len());
    for r in &rows {
        let schema: String = r.try_get("schema").map_err(db_error)?;
        let table: String = r.try_get("tbl").map_err(db_error)?;
        let col: String = r.try_get("col").map_err(db_error)?;
        let typ: String = r.try_get("typ").map_err(db_error)?;
        let cmt: String = r.try_get("cmt").map_err(db_error)?;
        let tbl_cmt: String = r.try_get("tbl_cmt").map_err(db_error)?;
        let pk: bool = r.try_get("pk").map_err(db_error)?;
        plain.push((
            table.clone(),
            tbl_cmt.clone(),
            SchemaColumn {
                name: col.clone(),
                data_type: typ.clone(),
                comment: cmt.clone(),
                pk,
            },
        ));
        qualified.push((
            format!("{schema}.{table}"),
            tbl_cmt,
            SchemaColumn {
                name: col,
                data_type: typ,
                comment: cmt,
                pk,
            },
        ));
    }
    let mut out = group_columns(plain);
    out.extend(group_columns(qualified));
    Ok(out)
}

/// PostgreSQL: テーブルのカラム名と型 (データ編集のキャストに使う)
pub async fn pg_column_types(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<Vec<(String, String)>, AppError> {
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;
    rows.iter()
        .map(|r| {
            Ok((
                r.try_get::<String, _>("name").map_err(db_error)?,
                r.try_get::<String, _>("type").map_err(db_error)?,
            ))
        })
        .collect()
}

/// PostgreSQL: カラムに使える型の一覧。
/// ユーザー定義のenumやドメイン、拡張 (PostGISのgeometry等) も含めたいのでDBから取る
pub async fn pg_types(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<String>, AppError> {
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
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;
    rows.iter()
        .map(|r| r.try_get::<String, _>("name").map_err(db_error))
        .collect()
}

/// PostgreSQL: 使える照合順序の一覧
pub async fn pg_collations(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<String>, AppError> {
    // 同名の照合順序が複数のスキーマにあることがあるので重複は除く
    let sql = "SELECT DISTINCT collname FROM pg_collation \
             WHERE collname <> 'default' ORDER BY collname";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;
    rows.iter()
        .map(|r| r.try_get::<String, _>("collname").map_err(db_error))
        .collect()
}

pub async fn pg_tables(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<TableInfo>, AppError> {
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;

    rows.iter()
        .map(|row| {
            let estimate: i64 = row.try_get("row_estimate").map_err(db_error)?;
            Ok(TableInfo {
                schema: row.try_get("schema").map_err(db_error)?,
                name: row.try_get("name").map_err(db_error)?,
                table_type: row.try_get("table_type").map_err(db_error)?,
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
) -> Result<TableDetail, AppError> {
    // カラム
    let binds = [schema, table];
    let rows =
        pg_rows(conn, &pg_columns_sql(Scope::One), &binds, QUERY_TIMEOUT, ctx).await?;

    let mut columns = Vec::with_capacity(rows.len());
    for r in &rows {
        columns.push(pg_column(r)?);
    }

    // インデックス
    let rows =
        pg_rows(conn, &pg_indexes_sql(Scope::One), &binds, QUERY_TIMEOUT, ctx).await?;

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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;

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

/// PostgreSQL: 全テーブルの定義 ((スキーマ, テーブル名) → 定義)
pub async fn pg_schema_details(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<HashMap<(String, String), TableDetail>, AppError> {
    let mut out: HashMap<(String, String), TableDetail> = HashMap::new();

    // カラム
    let rows =
        pg_rows(conn, &pg_columns_sql(Scope::All), &[], SCHEMA_TIMEOUT, ctx).await?;
    for r in &rows {
        let key = (
            r.try_get::<String, _>("schema").map_err(db_error)?,
            r.try_get::<String, _>("tbl").map_err(db_error)?,
        );
        out.entry(key).or_default().columns.push(pg_column(r)?);
    }

    // インデックス
    let rows =
        pg_rows(conn, &pg_indexes_sql(Scope::All), &[], SCHEMA_TIMEOUT, ctx).await?;
    for r in &rows {
        let key = (
            r.try_get::<String, _>("schema").map_err(db_error)?,
            r.try_get::<String, _>("tbl").map_err(db_error)?,
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
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;
    for r in &rows {
        let key = (
            r.try_get::<String, _>("schema").map_err(db_error)?,
            r.try_get::<String, _>("tbl").map_err(db_error)?,
        );
        out.entry(key).or_default().info = pg_table_info(r)?;
    }

    Ok(out)
}

/// PostgreSQL: カタログから CREATE TABLE 文を組み立てる。
/// PostgreSQLには SHOW CREATE TABLE が無いため、
/// カラム・制約・インデックス・コメントを集めて再構成する
pub async fn pg_table_ddl(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<String, AppError> {
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;
    let mut part_key: Option<String> = None;
    let mut part_of: Option<(String, String)> = None;
    if let Some(r) = &row {
        let kind: String = r.try_get("kind").map_err(db_error)?;
        if kind == "v" || kind == "m" {
            let def: String = r
                .try_get::<Option<String>, _>("viewdef")
                .map_err(db_error)?
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;
    if rows.is_empty() {
        return Err("定義が見つかりません".into());
    }

    let mut lines: Vec<String> = Vec::new();
    let mut comments: Vec<String> = Vec::new();
    for r in &rows {
        let name: String = r.try_get("name").map_err(db_error)?;
        let col_type: String = r.try_get("col_type").map_err(db_error)?;
        let notnull: bool = r.try_get("notnull").map_err(db_error)?;
        let identity: String = r.try_get("identity").map_err(db_error)?;
        let generated: bool = r.try_get("generated").map_err(db_error)?;
        let default: Option<String> = r.try_get("default_expr").map_err(db_error)?;
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
            .map_err(db_error)?
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;
    for r in &rows {
        let name: String = r.try_get("conname").map_err(db_error)?;
        let def: String = r.try_get("def").map_err(db_error)?;
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
pub(super) fn pg_partition_of(full: &str, parent: &str, bound: &str, sub_key: Option<&str>) -> String {
    let mut out = format!("CREATE TABLE {full} PARTITION OF {parent}\n    {bound}");
    // 子がさらに分かれている場合
    if let Some(key) = sub_key {
        out.push_str(&format!("\n    PARTITION BY {key}"));
    }
    out.push(';');
    out
}

/// 普通のテーブル (とパーティションの親) の CREATE 文
pub(super) fn pg_create_table(full: &str, lines: &[String], part_key: Option<&str>) -> String {
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
) -> Result<String, AppError> {
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;
    for r in &rows {
        let def: String = r.try_get("def").map_err(db_error)?;
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;
    if let Some(c) = row.and_then(|r| r.try_get::<Option<String>, _>("comment").ok().flatten()) {
        out.push_str(&format!("\n\nCOMMENT ON TABLE {full} IS {};", pg_literal(&c)));
    }
    Ok(out)
}

/// PostgreSQLの文字列リテラル (シングルクォートを重ねてエスケープ)
fn pg_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// PostgreSQL: 関数・プロシージャ・トリガの定義
pub async fn pg_routines(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<RoutineInfo>, AppError> {
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
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;
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
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;
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

/// PostgreSQL: 1テーブルの外部キー
pub async fn pg_foreign_key_defs(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<ForeignKeyInfo>, AppError> {
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;

    rows.iter()
        .map(|r| {
            // カラムが読めないまま「カラム0本の外部キー」を出すと
            // 画面では気づけないので、ここでエラーにする
            Ok(ForeignKeyInfo {
                name: r.try_get("name").map_err(db_error)?,
                columns: r.try_get("cols").map_err(db_error)?,
                // 同じスキーマなら省いて読みやすくする (MySQL側と同じ扱い)
            ref_schema: match r.try_get::<String, _>("ref_schema") {
                Ok(ns) if ns == schema => String::new(),
                Ok(ns) => ns,
                Err(e) => return Err(db_error(e)),
            },
                ref_table: r.try_get("ref_table").map_err(db_error)?,
                ref_columns: r.try_get("ref_cols").map_err(db_error)?,
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

/// PostgreSQL: 実行中の接続一覧 (他ユーザーのSQL本文は権限が無いと見えない)
pub async fn pg_processes(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
    log: bool,
) -> Result<Vec<ProcessInfo>, AppError> {
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
    .map_err(|_| AppError::timeout("クエリ"))?;
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
            .map_err(|_| AppError::timeout("クエリ"))?
            .map_err(db_error)?
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
