//! MySQL / MariaDB の書き出し。
//!
//! mysqldump --single-transaction --hex-blob と同じ考え方で書く。
//! - 1つのトランザクション (一貫したスナップショット) の中で全テーブルを読む
//! - 行はテキストのまま受け取り、まとめた INSERT (1文 約1MB) にする
//! - バイナリの列は16進で書く (文字コードで化けないように)
//! - 外部キーの確認は流し込みの間だけ止める (テーブルの順番を気にしなくてよい)

use std::collections::HashMap;

use futures_util::TryStreamExt;
use sqlx::mysql::{MySql, MySqlConnection, MySqlRow};
use sqlx::{AssertSqlSafe, Decode, Row, ValueRef};

use super::sql::{my_ident, push_my_hex, push_my_str, strip_definer, topo_order};
use super::{Mode, Out, Progress, CHUNK};
use crate::db::format_db_error;
use crate::models::ExportTable;
use crate::tools::Endpoint;

/// 値の書き方
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// 数値: テキストのまま
    Num,
    /// バイナリ: 16進
    Hex,
    /// 文字列・日時など: 引用符で囲む
    Str,
}

/// information_schema の DATA_TYPE から書き方を決める
pub fn kind_of(data_type: &str) -> Kind {
    match data_type.to_ascii_lowercase().as_str() {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "decimal"
        | "numeric" | "float" | "double" | "real" | "year" => Kind::Num,
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" | "bit"
        | "geometry" | "point" | "linestring" | "polygon" | "multipoint" | "multilinestring"
        | "multipolygon" | "geometrycollection" | "geomcollection" | "vector" => Kind::Hex,
        _ => Kind::Str,
    }
}

/// 生成列か (INSERT には書けない)。
///
/// MySQL 8 は式の既定値にも `DEFAULT_GENERATED` と出すので、それは外さない
pub fn is_generated(extra: &str) -> bool {
    let e = extra.to_ascii_uppercase();
    e.contains("VIRTUAL GENERATED") || e.contains("STORED GENERATED") || e.contains("PERSISTENT")
}

struct Col {
    name: String,
    kind: Kind,
}

struct Table {
    name: String,
    view: bool,
    rows: u64,
    size: u64,
}

/// 文字の列を取り出す (古い版では information_schema の列がバイナリで返ることがある)
fn text(row: &MySqlRow, i: usize) -> String {
    if let Ok(Some(s)) = row.try_get::<Option<String>, _>(i) {
        return s;
    }
    match row.try_get_unchecked::<Option<Vec<u8>>, _>(i) {
        Ok(Some(b)) => String::from_utf8_lossy(&b).to_string(),
        _ => String::new(),
    }
}

fn number(row: &MySqlRow, i: usize) -> u64 {
    if let Ok(Some(v)) = row.try_get::<Option<u64>, _>(i) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(i) {
        return v.max(0) as u64;
    }
    text(row, i).parse().unwrap_or(0)
}

async fn exec(conn: &mut MySqlConnection, sql: &str) -> Result<(), String> {
    sqlx::raw_sql(AssertSqlSafe(sql.to_string()))
        .execute(&mut *conn)
        .await
        .map(|_| ())
        .map_err(format_db_error)
}

async fn rows(conn: &mut MySqlConnection, sql: &str, binds: &[&str]) -> Result<Vec<MySqlRow>, String> {
    let mut q = sqlx::query(AssertSqlSafe(sql.to_string()));
    for b in binds {
        q = q.bind(b.to_string());
    }
    q.fetch_all(&mut *conn).await.map_err(format_db_error)
}

/// SHOW CREATE … の n 列目 (権限が無いと NULL になる)
async fn show_create(conn: &mut MySqlConnection, sql: &str, col: usize) -> Result<Option<String>, String> {
    Ok(show_row(conn, sql)
        .await?
        .map(|r| text(&r, col))
        .filter(|s| !s.trim().is_empty()))
}

/// SHOW CREATE … の1行 (準備をせずに送る。版によっては準備できない SHOW があるため)
async fn show_row(conn: &mut MySqlConnection, sql: &str) -> Result<Option<MySqlRow>, String> {
    sqlx::raw_sql(AssertSqlSafe(sql.to_string()))
        .fetch_optional(&mut *conn)
        .await
        .map_err(format_db_error)
}

/**
 * 関数・プロシージャ・トリガの定義を、DELIMITER で囲んで書く。
 *
 * 作ったときの sql_mode で作り直す (定義と一緒に記録されていて、本体の動きが変わるため)。
 * mysqldump と同じく、その間だけ切り替えて元に戻す
 */
pub(super) fn routine_block(drop: &str, sql_mode: &str, def: &str) -> String {
    format!(
        "\n{drop};\n\
         /*!50003 SET @saved_sql_mode = @@sql_mode */;\n\
         /*!50003 SET sql_mode = '{}' */;\n\
         DELIMITER ;;\n{} ;;\nDELIMITER ;\n\
         /*!50003 SET sql_mode = @saved_sql_mode */;\n",
        sql_mode.replace('\\', "\\\\").replace('\'', "\\'"),
        strip_definer(def)
    )
}

/// 書き出しの本体
pub async fn export(
    ep: &Endpoint,
    database: &str,
    tables: &[ExportTable],
    mode: Mode,
    p: &Progress,
    out: &mut Out,
) -> Result<(), String> {
    p.set_stage("接続しています");
    let mut conn = p
        .guard(crate::db::connect_mysql(
            &ep.host,
            ep.port,
            &ep.user,
            &ep.password,
            Some(database),
            &ep.tls,
        ))
        .await??;

    /*
     * 読む側が遅いと、サーバーが送るのを諦めることがある (既定は60秒)。
     * 時刻は UTC で読み書きする (TIMESTAMP列が流し込む先のタイムゾーンでずれないように)
     */
    for sql in [
        "SET SESSION net_write_timeout = 86400",
        "SET SESSION net_read_timeout = 86400",
        "SET SESSION wait_timeout = 86400",
        "SET SESSION max_execution_time = 0",
        "SET NAMES utf8mb4",
    ] {
        let _ = exec(&mut conn, sql).await;
    }
    exec(&mut conn, "SET time_zone = '+00:00'").await?;
    exec(&mut conn, "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ").await?;
    exec(&mut conn, "START TRANSACTION /*!40100 WITH CONSISTENT SNAPSHOT */").await?;

    p.set_stage("テーブルの情報を読んでいます");
    let all = p
        .guard(rows(
            &mut conn,
            "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ?",
            &[database],
        ))
        .await??;
    let mut known: HashMap<String, Table> = HashMap::new();
    for r in &all {
        let name = text(r, 0);
        known.insert(
            name.clone(),
            Table {
                name,
                view: text(r, 1).eq_ignore_ascii_case("VIEW"),
                rows: number(r, 2),
                size: number(r, 3),
            },
        );
    }
    let mut picked: Vec<&Table> = Vec::new();
    for t in tables {
        let found = known
            .get(&t.name)
            .ok_or_else(|| format!("テーブル {} が見つかりません", t.name))?;
        if !picked.iter().any(|x| x.name == found.name) {
            picked.push(found);
        }
    }
    let base: Vec<&Table> = picked.iter().copied().filter(|t| !t.view).collect();
    let views: Vec<&Table> = picked.iter().copied().filter(|t| t.view).collect();

    // 列 (生成列は INSERT に書けないので外す)
    let col_rows = p
        .guard(rows(
            &mut conn,
            "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, EXTRA FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
            &[database],
        ))
        .await??;
    let mut columns: HashMap<String, Vec<Col>> = HashMap::new();
    for r in &col_rows {
        if is_generated(&text(r, 3)) {
            continue;
        }
        columns.entry(text(r, 0)).or_default().push(Col {
            name: text(r, 1),
            kind: kind_of(&text(r, 2)),
        });
    }

    // トリガ (テーブルごと。発火の順番どおり)
    let mut triggers: HashMap<String, Vec<String>> = HashMap::new();
    let mut routines: Vec<(String, String)> = Vec::new();
    if mode.ddl() {
        let trig = p
            .guard(rows(
                &mut conn,
                "SELECT EVENT_OBJECT_TABLE, TRIGGER_NAME FROM information_schema.TRIGGERS \
                 WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER, TRIGGER_NAME",
                &[database],
            ))
            .await??;
        for r in &trig {
            triggers.entry(text(r, 0)).or_default().push(text(r, 1));
        }
        let rt = p
            .guard(rows(
                &mut conn,
                "SELECT ROUTINE_TYPE, ROUTINE_NAME FROM information_schema.ROUTINES \
                 WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME",
                &[database],
            ))
            .await??;
        routines = rt.iter().map(|r| (text(r, 0), text(r, 1))).collect();
    }

    // 重み: データの大きさ (定義だけのときは数で)
    let weight = |t: &Table| -> u64 {
        if mode.rows() {
            t.size + 16 * 1024
        } else {
            16 * 1024
        }
    };
    let total: u64 = base.iter().map(|t| weight(t)).sum::<u64>()
        + (views.len() + routines.len()) as u64 * 4096;
    p.set_total(total.max(1));

    out.text(&header(database)).await?;

    let n = base.len();
    for (i, t) in base.iter().enumerate() {
        p.set_stage(format!("{} ({}/{})", t.name, i + 1, n));
        p.begin(weight(t), if mode.rows() { t.rows } else { 0 });
        let name = my_ident(&t.name);
        if mode.ddl() {
            let ddl = p
                .guard(show_create(&mut conn, &format!("SHOW CREATE TABLE {name}"), 1))
                .await??
                .ok_or_else(|| format!("{} の定義を読めませんでした", t.name))?;
            out.text(&format!(
                "\n--\n-- テーブル {name}\n--\n\nDROP TABLE IF EXISTS {name};\n{ddl};\n"
            ))
            .await?;
        }
        if mode.rows() {
            let cols = columns.get(&t.name).map(Vec::as_slice).unwrap_or(&[]);
            table_rows(&mut conn, &t.name, cols, p, out).await?;
        }
        if mode.ddl() {
            for trig in triggers.get(&t.name).map(Vec::as_slice).unwrap_or(&[]) {
                let tname = my_ident(trig);
                let row = p
                    .guard(show_row(&mut conn, &format!("SHOW CREATE TRIGGER {tname}")))
                    .await??;
                match row.map(|r| (text(&r, 1), text(&r, 2))).filter(|(_, d)| !d.trim().is_empty()) {
                    Some((sql_mode, def)) => {
                        out.text(&routine_block(&format!("DROP TRIGGER IF EXISTS {tname}"), &sql_mode, &def))
                            .await?
                    }
                    None => p.note(format!("トリガ {trig} の定義を読めませんでした (権限が足りない可能性があります)")),
                }
            }
        }
        p.end();
    }

    if mode.ddl() {
        for (kind, name) in &routines {
            p.set_stage(format!("{} {name}", if kind == "FUNCTION" { "関数" } else { "プロシージャ" }));
            p.begin(4096, 0);
            let word = if kind == "FUNCTION" { "FUNCTION" } else { "PROCEDURE" };
            let ident = my_ident(name);
            let row = p
                .guard(show_row(&mut conn, &format!("SHOW CREATE {word} {ident}")))
                .await??;
            match row.map(|r| (text(&r, 1), text(&r, 2))).filter(|(_, d)| !d.trim().is_empty()) {
                Some((sql_mode, def)) => {
                    out.text(&routine_block(&format!("DROP {word} IF EXISTS {ident}"), &sql_mode, &def))
                        .await?
                }
                None => p.note(format!(
                    "{name} の定義を読めませんでした (作った人か、SHOW_ROUTINE 権限が必要です)"
                )),
            }
            p.end();
        }

        // ビューは、ほかのビューを参照していればそちらを先に作る
        let mut defs: Vec<(String, String)> = Vec::new();
        for v in &views {
            p.set_stage(format!("ビュー {}", v.name));
            let ident = my_ident(&v.name);
            let def = p
                .guard(show_create(&mut conn, &format!("SHOW CREATE VIEW {ident}"), 1))
                .await??
                .ok_or_else(|| format!("ビュー {} の定義を読めませんでした", v.name))?;
            // 同じDBの名前は修飾を外す (別の名前のDBへ戻しても、そのDBの表を見るように)
            let def = strip_definer(&def).replace(&format!("{}.", my_ident(database)), "");
            defs.push((v.name.clone(), def));
        }
        let deps: Vec<Vec<usize>> = defs
            .iter()
            .map(|(_, def)| {
                defs.iter()
                    .enumerate()
                    .filter(|(_, (other, _))| def.contains(&my_ident(other)))
                    .map(|(j, _)| j)
                    .collect()
            })
            .collect();
        for i in topo_order(defs.len(), &deps) {
            let (name, def) = &defs[i];
            let ident = my_ident(name);
            p.begin(4096, 0);
            out.text(&format!(
                "\n--\n-- ビュー {ident}\n--\n\nDROP TABLE IF EXISTS {ident};\nDROP VIEW IF EXISTS {ident};\n{def};\n"
            ))
            .await?;
            p.end();
        }
    }

    let _ = exec(&mut conn, "COMMIT").await;
    out.text(FOOTER).await?;
    out.text(&format!(
        "\n-- 出力完了 {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    ))
    .await?;
    Ok(())
}

/// ファイルの先頭 (流し込みの間だけ設定を変え、最後に戻す)
fn header(database: &str) -> String {
    format!(
        "-- Quelio SQLダンプ (MySQL)\n\
         -- データベース: {database}\n\
         -- 作成日時: {}\n\n\
         /*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\n\
         /*!40101 SET NAMES utf8mb4 */;\n\
         /*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;\n\
         /*!40103 SET TIME_ZONE='+00:00' */;\n\
         /*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;\n\
         /*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;\n\
         /*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\n\
         /*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    )
}

const FOOTER: &str = "\n/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n\
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;\n\
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;\n\
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;\n\
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;\n\
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;\n";

/// 1テーブルの全行を INSERT 文にして書く
async fn table_rows(
    conn: &mut MySqlConnection,
    table: &str,
    cols: &[Col],
    p: &Progress,
    out: &mut Out,
) -> Result<(), String> {
    if cols.is_empty() {
        return Ok(());
    }
    let name = my_ident(table);
    let list = cols
        .iter()
        .map(|c| my_ident(&c.name))
        .collect::<Vec<_>>()
        .join(", ");
    // テキストで受け取る (raw_sql は準備なしで送るので、値が文字のまま届く)
    let sql = format!("SELECT {list} FROM {name}");
    let prefix = format!("INSERT INTO {name} ({list}) VALUES\n");

    out.text(&format!(
        "\n--\n-- データ {name}\n--\n\n/*!40000 ALTER TABLE {name} DISABLE KEYS */;\n"
    ))
    .await?;

    let mut buf: Vec<u8> = Vec::with_capacity(CHUNK + CHUNK / 4);
    let mut in_stmt = false;
    let mut pending: u64 = 0;
    {
        let mut stream = sqlx::raw_sql(AssertSqlSafe(sql)).fetch(&mut *conn);
        loop {
            let row = match p.guard(stream.try_next()).await? {
                Ok(Some(r)) => r,
                Ok(None) => break,
                Err(e) => return Err(format!("{table} を読めませんでした: {}", format_db_error(e))),
            };
            if in_stmt {
                buf.extend_from_slice(b",\n(");
            } else {
                buf.extend_from_slice(prefix.as_bytes());
                buf.push(b'(');
                in_stmt = true;
            }
            for (i, c) in cols.iter().enumerate() {
                if i > 0 {
                    buf.push(b',');
                }
                let v = row.try_get_raw(i).map_err(format_db_error)?;
                if v.is_null() {
                    buf.extend_from_slice(b"NULL");
                    continue;
                }
                let bytes = <&[u8] as Decode<MySql>>::decode(v)
                    .map_err(|e| format!("{table} の値を読めませんでした: {e}"))?;
                match c.kind {
                    Kind::Num => buf.extend_from_slice(bytes),
                    Kind::Hex => push_my_hex(&mut buf, bytes),
                    Kind::Str => push_my_str(&mut buf, bytes),
                }
            }
            buf.push(b')');
            pending += 1;
            if buf.len() >= CHUNK {
                buf.extend_from_slice(b";\n");
                in_stmt = false;
                p.add_rows(pending);
                pending = 0;
                out.write(&mut buf).await?;
            }
        }
    }
    if in_stmt {
        buf.extend_from_slice(b";\n");
    }
    p.add_rows(pending);
    buf.extend_from_slice(format!("/*!40000 ALTER TABLE {name} ENABLE KEYS */;\n").as_bytes());
    out.write(&mut buf).await
}
