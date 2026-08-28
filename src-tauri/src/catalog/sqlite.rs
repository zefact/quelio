//! SQLite のカタログ問い合わせ。
//!
//! 情報スキーマが無く PRAGMA と sqlite_master を読むため、
//! 他の2つとは組み立てがかなり違う

use super::*;

/// SQLite: 補完用のテーブル・カラム一覧 (コメントの仕組みが無いので空で返す)
pub async fn sqlite_schema_columns(
    conn: &mut SqliteConnection,
    ctx: &LogCtx<'_>,
) -> Result<SchemaColumns, AppError> {
    let sql = "SELECT m.name AS tbl, p.name AS col, p.\"type\" AS typ \
             FROM sqlite_master m \
             JOIN pragma_table_info(m.name) p \
             WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%' \
             ORDER BY m.name, p.cid";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;
    let pairs = rows
        .iter()
        .map(|r| {
            Ok((
                r.try_get::<String, _>("tbl").map_err(db_error)?,
                String::new(),
                SchemaColumn {
                    name: r.try_get::<String, _>("col").map_err(db_error)?,
                    data_type: r.try_get::<String, _>("typ").map_err(db_error)?,
                    comment: String::new(),
                },
            ))
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    Ok(group_columns(pairs))
}

/// SQLite: バージョン・文字コード・ファイルサイズなど
pub async fn sqlite_server_info(
    conn: &mut SqliteConnection,
    path: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<(String, String)>, AppError> {
    let sql = "SELECT sqlite_version() AS version, \
               (SELECT encoding FROM pragma_encoding()) AS encoding, \
               (SELECT page_size FROM pragma_page_size()) AS page_size";
    ctx.log(sql);
    let row = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_one(conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;

    let version: String = row.try_get("version").map_err(db_error)?;
    let encoding: String = row.try_get("encoding").map_err(db_error)?;
    let page_size: i64 = row.try_get("page_size").map_err(db_error)?;

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
) -> Result<Vec<TableInfo>, AppError> {
    let sql = "SELECT name, type FROM sqlite_master \
               WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
               ORDER BY name";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;

    rows.iter()
        .map(|row| {
            let kind: String = row.try_get("type").map_err(db_error)?;
            Ok(TableInfo {
                schema: None,
                name: row.try_get("name").map_err(db_error)?,
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
) -> Result<TableDetail, AppError> {
    // カラム (SQLiteにはカラムコメントの概念が無い)
    let sql = "SELECT name, type, \"notnull\", dflt_value, pk \
               FROM pragma_table_info(?) ORDER BY cid";
    ctx.log(&sql.replacen('?', &format!("'{table}'"), 1));
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(table).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;

    let mut columns = Vec::with_capacity(rows.len());
    // 主キーのカラム (pkは1始まりの並び順)
    let mut pk_columns: Vec<(i64, String)> = Vec::new();
    for r in &rows {
        let notnull: i64 = r.try_get("notnull").map_err(db_error)?;
        let pk: i64 = r.try_get("pk").map_err(db_error)?;
        if pk > 0 {
            pk_columns.push((pk, r.try_get("name").map_err(db_error)?));
        }
        let col_type: String = r.try_get("type").map_err(db_error)?;
        columns.push(ColumnInfo {
            name: r.try_get("name").map_err(db_error)?,
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
                .map_err(db_error)?,
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;

    let mut indexes = Vec::with_capacity(idx_rows.len());
    for r in &idx_rows {
        let name: String = r.try_get("name").map_err(db_error)?;
        let unique: i64 = r.try_get("unique").map_err(db_error)?;
        let origin: String = r.try_get("origin").map_err(db_error)?;
        let partial: i64 = r.try_get("partial").map_err(db_error)?;

        // インデックスを構成するカラム (seqno順)
        let col_sql = "SELECT name FROM pragma_index_info(?) ORDER BY seqno";
        ctx.log(&col_sql.replacen('?', &format!("'{name}'"), 1));
        let cols = timeout(
            QUERY_TIMEOUT,
            sqlx::query(col_sql).bind(&name).fetch_all(&mut *conn),
        )
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;
        let columns_text = cols
            .iter()
            .map(|c| {
                c.try_get::<Option<String>, _>("name")
                    .map_err(db_error)
                    // 式インデックスはカラム名がNULLになる
                    .map(|v| v.unwrap_or_else(|| "(式)".to_string()))
            })
            .collect::<Result<Vec<_>, AppError>>()?
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
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;

    let mut info = Vec::new();
    if let Some(r) = row {
        let kind: String = r.try_get("type").map_err(db_error)?;
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
                .map_err(db_error)?
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
) -> Result<Vec<FkInfo>, AppError> {
    // 参照先カラム(to)は省略できるため、その場合は参照先の主キーで補う
    let sql = "SELECT m.name AS table_name, fk.\"from\" AS column_name, \
                    fk.\"table\" AS ref_table, fk.\"to\" AS ref_column \
             FROM sqlite_master m, pragma_foreign_key_list(m.name) fk \
             WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
             ORDER BY m.name, fk.id, fk.seq";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;

    let mut fks = Vec::with_capacity(rows.len());
    for r in &rows {
        let ref_table: String = r.try_get("ref_table").map_err(db_error)?;
        let ref_column: Option<String> = r.try_get("ref_column").map_err(db_error)?;
        let ref_column = match ref_column {
            Some(c) => c,
            None => sqlite_primary_key(conn, &ref_table).await?,
        };
        fks.push(FkInfo {
            table: r.try_get("table_name").map_err(db_error)?,
            column: r.try_get("column_name").map_err(db_error)?,
            ref_table,
            ref_column,
        });
    }
    Ok(fks)
}

/// SQLite: 指定テーブルの主キーカラム名 (無ければ rowid)
async fn sqlite_primary_key(conn: &mut SqliteConnection, table: &str) -> Result<String, AppError> {
    let sql = "SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk LIMIT 1";
    let row = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(table).fetch_optional(&mut *conn),
    )
    .await
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;
    match row {
        Some(r) => r.try_get("name").map_err(db_error),
        None => Ok("rowid".to_string()),
    }
}

/// SQLite: sqlite_master に記録されている定義 (テーブル本体 + インデックス)
pub async fn sqlite_table_ddl(
    conn: &mut SqliteConnection,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<String, AppError> {
    let sql = "SELECT sql FROM sqlite_master \
               WHERE tbl_name = ? AND sql IS NOT NULL \
               ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 0 ELSE 1 END, name";
    ctx.log(&sql.replacen('?', &format!("'{table}'"), 1));
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(table).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;
    let mut parts: Vec<String> = Vec::new();
    for r in &rows {
        let s: String = r.try_get("sql").map_err(db_error)?;
        parts.push(format!("{};", s.trim()));
    }
    if parts.is_empty() {
        return Err("定義が見つかりません".into());
    }
    Ok(parts.join("\n\n"))
}

/// SQLite: トリガの定義 (関数・プロシージャは持たない)
pub async fn sqlite_routines(
    conn: &mut SqliteConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<RoutineInfo>, AppError> {
    let sql = "SELECT name, tbl_name, sql FROM sqlite_master \
               WHERE type = 'trigger' ORDER BY tbl_name, name";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;
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

/// SQLite: 1テーブルの外部キー (PRAGMA foreign_key_list)
pub async fn sqlite_foreign_key_defs(
    conn: &mut SqliteConnection,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<ForeignKeyInfo>, AppError> {
    // pragma_foreign_key_list は表として読めるので、名前をそのまま渡せる
    let sql = "SELECT id, seq, \"table\", \"from\", \"to\", on_update, on_delete \
               FROM pragma_foreign_key_list(?) ORDER BY id, seq";
    ctx.log(sql);
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(table).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;

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
