//! SQLファイルの流し込み。
//!
//! ファイルを読んで文に分ける処理を別のスレッドで先に進めておき、
//! こちらは届いた文を順に実行する (読む時間と実行の待ち時間を重ねる)。
//!
//! 速くするための工夫:
//! - MySQL: 小さな文 (1行ずつの INSERT など) は、まとめて1回で送る (往復の回数を減らす)
//! - PostgreSQL: `COPY … FROM stdin` のデータは COPY のまま流す
//! - どれも準備 (prepare) をせずに、そのまま送る

use std::path::Path;

use sqlx::mysql::MySqlConnection;
use sqlx::postgres::PgConnection;
use sqlx::sqlite::SqliteConnection;
use sqlx::{AssertSqlSafe, Connection};
use tokio::sync::mpsc;

use super::split::{Flavor, Item, Splitter};
use super::{Progress, CANCELLED};
use crate::db::format_db_error;
use crate::models::DbType;
use crate::tools::Endpoint;

/// MySQL で、まとめて送る文の大きさの上限
const BATCH_BYTES: usize = 1024 * 1024;
/// MySQL で、まとめて送る文の数の上限
const BATCH_STMTS: usize = 2000;
/// エラーに添える文の長さ
const SNIPPET: usize = 300;

/// 読む側のスレッドから届くもの
enum Msg {
    Item(Item),
    Fail(String),
}

/// ファイルを読んで文に分けるスレッドを動かす
fn spawn_reader(path: &Path, flavor: Flavor) -> Result<mpsc::Receiver<Msg>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("ファイルを開けません: {e}"))?;
    let (tx, rx) = mpsc::channel::<Msg>(64);
    std::thread::spawn(move || {
        let mut sp = Splitter::new(file, flavor);
        loop {
            match sp.next_item() {
                Ok(Some(item)) => {
                    if tx.blocking_send(Msg::Item(item)).is_err() {
                        return;
                    }
                }
                Ok(None) => return,
                Err(e) => {
                    let _ = tx.blocking_send(Msg::Fail(format!("ファイルを読めませんでした: {e}")));
                    return;
                }
            }
        }
    });
    Ok(rx)
}

fn to_text(bytes: Vec<u8>, line: u64) -> Result<String, String> {
    String::from_utf8(bytes)
        .map_err(|_| format!("{line}行目の文がUTF-8ではありません。UTF-8のファイルにしてから実行してください"))
}

fn snippet(sql: &str) -> String {
    let t = sql.trim();
    if t.chars().count() > SNIPPET {
        format!("{}…", t.chars().take(SNIPPET).collect::<String>())
    } else {
        t.to_string()
    }
}

fn failed(line: u64, sql: &str, err: String) -> String {
    format!("{line}行目の文で失敗しました: {err}\n{}", snippet(sql))
}

/// 流し込みの本体 (実行した文の数を返す)
pub async fn run(ep: &Endpoint, database: &str, path: &Path, p: &Progress) -> Result<u64, String> {
    let flavor = match ep.db_type {
        DbType::Mysql => Flavor::Mysql,
        DbType::Postgresql => Flavor::Pg,
        DbType::Sqlite => Flavor::Sqlite,
        DbType::Valkey => return Err("この接続ではSQLファイルの実行は使えません".into()),
    };
    p.set_stage("接続しています");
    let total = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    p.set_total(total.max(1));
    let rx = spawn_reader(path, flavor)?;
    let count = match ep.db_type {
        DbType::Mysql => {
            let conn = p
                .guard(crate::db::connect_mysql(
                    &ep.host,
                    ep.port,
                    &ep.user,
                    &ep.password,
                    Some(database),
                    &ep.tls,
                ))
                .await??;
            mysql(ep, conn, rx, p).await
        }
        DbType::Postgresql => {
            let conn = p
                .guard(crate::db::connect_pg(
                    &ep.host,
                    ep.port,
                    &ep.user,
                    &ep.password,
                    Some(database),
                    &ep.tls,
                ))
                .await??;
            pg(ep, conn, rx, p).await
        }
        DbType::Sqlite => {
            let conn = crate::db::connect_sqlite(&ep.sqlite_path, false).await?;
            sqlite(conn, rx, p).await
        }
        DbType::Valkey => unreachable!(),
    }?;
    // 最後の文の後ろ (コメントや空行) も読み終えている
    p.set_done(total.max(1));
    p.set_bytes(total);
    Ok(count)
}

/// 経過の表示 (何文目・何行目か)
fn stage(p: &Progress, count: u64, line: u64) {
    p.set_stage(format!("{}文目 ({}行目)", count, line));
}

// ---------- MySQL ----------

/// まとめて送る途中の文
#[derive(Default)]
struct Batch {
    sql: String,
    stmts: usize,
    line: u64,
    end: u64,
}

async fn mysql(
    ep: &Endpoint,
    mut conn: MySqlConnection,
    mut rx: mpsc::Receiver<Msg>,
    p: &Progress,
) -> Result<u64, String> {
    for sql in [
        "SET SESSION net_read_timeout = 86400",
        "SET SESSION net_write_timeout = 86400",
        "SET SESSION wait_timeout = 86400",
    ] {
        let _ = sqlx::raw_sql(sql).execute(&mut conn).await;
    }
    let id: Option<u64> = sqlx::query_scalar("SELECT CONNECTION_ID()")
        .fetch_one(&mut conn)
        .await
        .ok();

    let mut count: u64 = 0;
    let mut batch = Batch::default();

    // 1回で送る (失敗したら、まとめた最初の文の行を知らせる)
    async fn send(
        ep: &Endpoint,
        conn: &mut MySqlConnection,
        id: Option<u64>,
        b: &mut Batch,
        p: &Progress,
    ) -> Result<(), String> {
        if b.stmts == 0 {
            return Ok(());
        }
        let sql = std::mem::take(&mut b.sql);
        let res = p
            .guard(sqlx::raw_sql(AssertSqlSafe(sql.clone())).execute(&mut *conn))
            .await;
        let line = b.line;
        let many = b.stmts > 1;
        b.stmts = 0;
        match res {
            Ok(Ok(_)) => {
                p.set_done(b.end);
                p.set_bytes(b.end);
                Ok(())
            }
            Ok(Err(e)) => {
                let err = format_db_error(e);
                Err(if many {
                    format!("{line}行目から始まる文のどれかで失敗しました: {err}\n{}", snippet(&sql))
                } else {
                    failed(line, &sql, err)
                })
            }
            Err(e) => {
                // 実行中の文をサーバー側でも止める
                if let Some(id) = id {
                    kill_mysql(ep, id).await;
                }
                Err(e)
            }
        }
    }

    loop {
        let msg = match p.guard(rx.recv()).await {
            Ok(Some(m)) => m,
            Ok(None) => break,
            Err(e) => {
                if let Some(id) = id {
                    kill_mysql(ep, id).await;
                }
                return Err(e);
            }
        };
        let item = match msg {
            Msg::Item(i) => i,
            Msg::Fail(e) => return Err(e),
        };
        let Item::Sql { text, line, end, custom } = item else {
            // MySQL の文の分け方では、ほかのものは出てこない
            continue;
        };
        let sql = to_text(text, line)?;
        count += 1;
        if count % 64 == 1 {
            stage(p, count, line);
        }
        // DELIMITER で区切った文 (関数の本体など) と大きな文は、それだけで送る
        if custom || sql.len() >= BATCH_BYTES {
            send(ep, &mut conn, id, &mut batch, p).await?;
            batch = Batch { sql, stmts: 1, line, end };
            send(ep, &mut conn, id, &mut batch, p).await?;
            continue;
        }
        if batch.stmts > 0 && (batch.sql.len() + sql.len() > BATCH_BYTES || batch.stmts >= BATCH_STMTS) {
            send(ep, &mut conn, id, &mut batch, p).await?;
        }
        if batch.stmts == 0 {
            batch.line = line;
        }
        batch.sql.push_str(&sql);
        // 文の終わりが行コメントでも、区切りが消えないように改行を挟む
        batch.sql.push_str("\n;\n");
        batch.stmts += 1;
        batch.end = end;
    }
    send(ep, &mut conn, id, &mut batch, p).await?;
    let _ = conn.close().await;
    Ok(count)
}

/// 別の接続から、実行中の文を止める
async fn kill_mysql(ep: &Endpoint, id: u64) {
    if let Ok(mut c) =
        crate::db::connect_mysql(&ep.host, ep.port, &ep.user, &ep.password, None, &ep.tls).await
    {
        let _ = sqlx::raw_sql(AssertSqlSafe(format!("KILL QUERY {id}")))
            .execute(&mut c)
            .await;
        let _ = c.close().await;
    }
}

// ---------- PostgreSQL ----------

async fn pg(
    ep: &Endpoint,
    mut conn: PgConnection,
    mut rx: mpsc::Receiver<Msg>,
    p: &Progress,
) -> Result<u64, String> {
    let pid: Option<i32> = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut conn)
        .await
        .ok();
    let cancel = || async {
        if let Some(pid) = pid {
            cancel_pg(ep, pid).await;
        }
    };
    let mut count: u64 = 0;

    loop {
        let msg = match p.guard(rx.recv()).await {
            Ok(Some(m)) => m,
            Ok(None) => break,
            Err(e) => {
                cancel().await;
                return Err(e);
            }
        };
        let item = match msg {
            Msg::Item(i) => i,
            Msg::Fail(e) => return Err(e),
        };
        match item {
            Item::Sql { text, line, end, .. } => {
                let sql = to_text(text, line)?;
                count += 1;
                if count % 16 == 1 {
                    stage(p, count, line);
                }
                match p.guard(sqlx::raw_sql(AssertSqlSafe(sql.clone())).execute(&mut conn)).await {
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => {
                        // 新しい pg_dump が書く設定 (transaction_timeout など) は、古い版には無い。
                        // psql と同じく、知らない設定の SET は飛ばして続ける
                        if is_unknown_setting(&sql, &e) {
                            p.note(format!("この版のPostgreSQLに無い設定を飛ばしました: {}", snippet(&sql)));
                        } else {
                            return Err(failed(line, &sql, format_db_error(e)));
                        }
                    }
                    Err(e) => {
                        cancel().await;
                        return Err(e);
                    }
                }
                p.set_done(end);
                p.set_bytes(end);
            }
            Item::CopyStart { text, line, .. } => {
                let sql = to_text(text, line)?;
                count += 1;
                stage(p, count, line);
                copy_in(&mut conn, &sql, line, &mut rx, p).await?;
            }
            Item::Meta { text, line, end } => {
                let cmd = text.split_whitespace().next().unwrap_or("").to_string();
                // pg_dump の \restrict / \unrestrict は psql 用の守りなので、黙って飛ばす
                if cmd != "\\restrict" && cmd != "\\unrestrict" {
                    p.note(format!("psql の命令 ({line}行目の {cmd}) は実行せずに飛ばしました"));
                }
                p.set_done(end);
                p.set_bytes(end);
            }
            Item::CopyData { .. } | Item::CopyEnd { .. } => {}
        }
        if p.stopped() {
            cancel().await;
            return Err(CANCELLED.into());
        }
    }
    let _ = conn.close().await;
    Ok(count)
}

/// COPY のデータを、届くそばから送る
async fn copy_in(
    conn: &mut PgConnection,
    sql: &str,
    line: u64,
    rx: &mut mpsc::Receiver<Msg>,
    p: &Progress,
) -> Result<(), String> {
    let mut copy = p
        .guard(conn.copy_in_raw(sql))
        .await?
        .map_err(|e| failed(line, sql, format_db_error(e)))?;
    loop {
        let msg = p.guard(rx.recv()).await?;
        match msg {
            Some(Msg::Item(Item::CopyData { data, end })) => {
                if let Err(e) = p.guard(copy.send(data)).await? {
                    return Err(failed(line, sql, format_db_error(e)));
                }
                p.set_done(end);
                p.set_bytes(end);
            }
            Some(Msg::Item(Item::CopyEnd { end })) => {
                p.guard(copy.finish())
                    .await?
                    .map_err(|e| failed(line, sql, format_db_error(e)))?;
                p.set_done(end);
                p.set_bytes(end);
                return Ok(());
            }
            Some(Msg::Fail(e)) => {
                let _ = copy.abort(e.clone()).await;
                return Err(e);
            }
            Some(Msg::Item(_)) | None => {
                let _ = copy.abort("データが途中で終わっています").await;
                return Err(failed(line, sql, "COPY のデータが途中で終わっています".into()));
            }
        }
    }
}

/// 知らない設定の SET で失敗したか
fn is_unknown_setting(sql: &str, e: &sqlx::Error) -> bool {
    let head = sql.trim_start().get(..4).unwrap_or("");
    head.eq_ignore_ascii_case("SET ")
        && e.as_database_error()
            .and_then(|d| d.code())
            .is_some_and(|c| c == "42704")
}

async fn cancel_pg(ep: &Endpoint, pid: i32) {
    if let Ok(mut c) =
        crate::db::connect_pg_fallback(&ep.host, ep.port, &ep.user, &ep.password, None, &ep.tls).await
    {
        let _ = sqlx::query("SELECT pg_cancel_backend($1)")
            .bind(pid)
            .execute(&mut c.0)
            .await;
        let _ = c.0.close().await;
    }
}

// ---------- SQLite ----------

async fn sqlite(
    mut conn: SqliteConnection,
    mut rx: mpsc::Receiver<Msg>,
    p: &Progress,
) -> Result<u64, String> {
    let mut count: u64 = 0;
    loop {
        let msg = match p.guard(rx.recv()).await? {
            Some(m) => m,
            None => break,
        };
        let item = match msg {
            Msg::Item(i) => i,
            Msg::Fail(e) => return Err(e),
        };
        let Item::Sql { text, line, end, .. } = item else {
            continue;
        };
        let sql = to_text(text, line)?;
        count += 1;
        if count % 256 == 1 {
            stage(p, count, line);
        }
        p.guard(sqlx::raw_sql(AssertSqlSafe(sql.clone())).execute(&mut conn))
            .await?
            .map_err(|e| failed(line, &sql, format_db_error(e)))?;
        p.set_done(end);
        p.set_bytes(end);
    }
    let _ = conn.close().await;
    Ok(count)
}
