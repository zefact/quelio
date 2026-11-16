//! SQLite の書き出し。
//!
//! sqlite3 コマンドの `.dump` と同じ形にする。
//! 全体を1つのトランザクションに入れるので、流し込みも速い

use futures_util::TryStreamExt;
use sqlx::sqlite::{Sqlite, SqliteConnection};
use sqlx::{AssertSqlSafe, Decode, Row, TypeInfo, ValueRef};

use super::sql::{dq_ident, float_text, push_sqlite_blob, push_std_str, std_literal};
use super::{Mode, Out, Progress, CHUNK};
use crate::db::format_db_error;
use crate::models::ExportTable;
use crate::tools::Endpoint;

/// 1つの INSERT に入れる行の上限 (古いSQLiteでも読めるように)
const ROWS_PER_INSERT: usize = 500;

struct Object {
    kind: String,
    name: String,
    table: String,
    sql: String,
}

async fn exec(conn: &mut SqliteConnection, sql: &str) -> Result<(), String> {
    sqlx::raw_sql(AssertSqlSafe(sql.to_string()))
        .execute(&mut *conn)
        .await
        .map(|_| ())
        .map_err(format_db_error)
}

pub async fn export(
    ep: &Endpoint,
    tables: &[ExportTable],
    mode: Mode,
    p: &Progress,
    out: &mut Out,
) -> Result<(), String> {
    p.set_stage("ファイルを開いています");
    let mut conn = crate::db::connect_sqlite(&ep.sqlite_path, true).await?;
    // 読み始めから終わりまで、同じ時点の中身を見る
    exec(&mut conn, "BEGIN").await?;

    let rows = sqlx::query(
        "SELECT type, name, tbl_name, sql FROM sqlite_master \
         WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid",
    )
    .fetch_all(&mut conn)
    .await
    .map_err(format_db_error)?;
    let objects: Vec<Object> = rows
        .iter()
        .map(|r| Object {
            kind: r.try_get(0).unwrap_or_default(),
            name: r.try_get(1).unwrap_or_default(),
            table: r.try_get(2).unwrap_or_default(),
            sql: r.try_get(3).unwrap_or_default(),
        })
        .collect();

    let mut picked: Vec<&Object> = Vec::new();
    for t in tables {
        let o = objects
            .iter()
            .find(|o| o.name == t.name && (o.kind == "table" || o.kind == "view"))
            .ok_or_else(|| format!("テーブル {} が見つかりません", t.name))?;
        if !picked.iter().any(|x| x.name == o.name) {
            picked.push(o);
        }
    }
    let tabs: Vec<&Object> = picked.iter().copied().filter(|o| o.kind == "table").collect();
    let views: Vec<&Object> = picked.iter().copied().filter(|o| o.kind == "view").collect();

    // 行数を数えて重みにする (SQLiteは手元のファイルなので、数えてもすぐ終わる)
    let mut counts: Vec<u64> = Vec::new();
    for t in &tabs {
        let n: i64 = if mode.rows() {
            sqlx::query_scalar(AssertSqlSafe(format!("SELECT count(*) FROM {}", dq_ident(&t.name))))
                .fetch_one(&mut conn)
                .await
                .map_err(format_db_error)?
        } else {
            0
        };
        counts.push(n.max(0) as u64);
    }
    let total: u64 = counts.iter().map(|n| n + 100).sum::<u64>() + views.len() as u64 * 100;
    p.set_total(total.max(1));

    out.text(&format!(
        "-- Quelio SQLダンプ (SQLite)\n-- 作成日時: {}\n\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    ))
    .await?;

    let has_seq: bool = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM sqlite_master WHERE name = 'sqlite_sequence'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap_or(0)
        > 0;

    let n = tabs.len();
    for (i, t) in tabs.iter().enumerate() {
        p.set_stage(format!("{} ({}/{})", t.name, i + 1, n));
        p.begin(counts[i] + 100, counts[i]);
        let name = dq_ident(&t.name);
        if mode.ddl() {
            out.text(&format!("\nDROP TABLE IF EXISTS {name};\n{};\n", t.sql)).await?;
        }
        if mode.rows() {
            table_rows(&mut conn, &t.name, p, out).await?;
            if has_seq {
                let seq: Option<i64> = sqlx::query_scalar("SELECT seq FROM sqlite_sequence WHERE name = ?")
                    .bind(&t.name)
                    .fetch_optional(&mut conn)
                    .await
                    .map_err(format_db_error)?;
                if let Some(seq) = seq {
                    let lit = std_literal(&t.name);
                    out.text(&format!(
                        "DELETE FROM sqlite_sequence WHERE name = {lit};\nINSERT INTO sqlite_sequence (name, seq) VALUES ({lit}, {seq});\n"
                    ))
                    .await?;
                }
            }
        }
        if mode.ddl() {
            // インデックスとトリガはデータの後 (入れながら更新するより速い)
            let mut tail = String::new();
            for o in objects
                .iter()
                .filter(|o| o.table == t.name && (o.kind == "index" || o.kind == "trigger"))
            {
                tail.push_str(&format!("{};\n", o.sql));
            }
            out.text(&tail).await?;
        }
        p.end();
    }
    if mode.ddl() {
        for v in &views {
            p.begin(100, 0);
            out.text(&format!(
                "\nDROP VIEW IF EXISTS {};\n{};\n",
                dq_ident(&v.name),
                v.sql
            ))
            .await?;
            p.end();
        }
    }
    let _ = exec(&mut conn, "COMMIT").await;
    out.text("COMMIT;\n").await?;
    Ok(())
}

/// 1テーブルの全行を INSERT 文にする (生成列は書けないので外す)
async fn table_rows(
    conn: &mut SqliteConnection,
    table: &str,
    p: &Progress,
    out: &mut Out,
) -> Result<(), String> {
    let name = dq_ident(table);
    let info = sqlx::query(AssertSqlSafe(format!("PRAGMA table_xinfo({name})")))
        .fetch_all(&mut *conn)
        .await
        .map_err(format_db_error)?;
    let cols: Vec<String> = info
        .iter()
        .filter(|r| r.try_get::<i64, _>("hidden").unwrap_or(0) == 0)
        .map(|r| r.try_get::<String, _>("name").unwrap_or_default())
        .collect();
    if cols.is_empty() {
        return Ok(());
    }
    let list = cols.iter().map(|c| dq_ident(c)).collect::<Vec<_>>().join(",");
    let prefix = format!("INSERT INTO {name} ({list}) VALUES");
    let sql = format!("SELECT {list} FROM {name}");

    let mut buf: Vec<u8> = Vec::with_capacity(CHUNK + CHUNK / 4);
    let mut in_stmt = 0usize;
    let mut pending = 0u64;
    let mut stream = sqlx::raw_sql(AssertSqlSafe(sql)).fetch(&mut *conn);
    loop {
        let row = match p.guard(stream.try_next()).await? {
            Ok(Some(r)) => r,
            Ok(None) => break,
            Err(e) => return Err(format!("{table} を読めませんでした: {}", format_db_error(e))),
        };
        if in_stmt == 0 {
            buf.extend_from_slice(prefix.as_bytes());
            buf.push(b'(');
        } else {
            buf.extend_from_slice(b",(");
        }
        for i in 0..cols.len() {
            if i > 0 {
                buf.push(b',');
            }
            let v = row.try_get_raw(i).map_err(format_db_error)?;
            if v.is_null() {
                buf.extend_from_slice(b"NULL");
                continue;
            }
            let ty = v.type_info().name().to_string();
            match ty.as_str() {
                "INTEGER" => {
                    let n = <i64 as Decode<Sqlite>>::decode(v).map_err(|e| e.to_string())?;
                    buf.extend_from_slice(n.to_string().as_bytes());
                }
                "REAL" => {
                    let f = <f64 as Decode<Sqlite>>::decode(v).map_err(|e| e.to_string())?;
                    buf.extend_from_slice(float_text(f).as_bytes());
                }
                "BLOB" => {
                    let b = <&[u8] as Decode<Sqlite>>::decode(v).map_err(|e| e.to_string())?;
                    push_sqlite_blob(&mut buf, b);
                }
                _ => {
                    let b = <&[u8] as Decode<Sqlite>>::decode(v).map_err(|e| e.to_string())?;
                    push_std_str(&mut buf, b);
                }
            }
        }
        buf.push(b')');
        in_stmt += 1;
        pending += 1;
        if in_stmt >= ROWS_PER_INSERT || buf.len() >= CHUNK {
            buf.extend_from_slice(b";\n");
            in_stmt = 0;
            if buf.len() >= CHUNK {
                p.add_rows(pending);
                pending = 0;
                out.write(&mut buf).await?;
            }
        }
    }
    if in_stmt > 0 {
        buf.extend_from_slice(b";\n");
    }
    p.add_rows(pending);
    out.write(&mut buf).await
}
