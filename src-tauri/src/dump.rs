//! Quelio 自身で行う SQL ダンプの書き出しと流し込み。
//!
//! mysqldump / pg_dump / mysql / psql を入れなくても、
//! 今の接続 (SSH踏み台・SSMの転送も含む) のままバックアップと復元ができるようにする。
//!
//! 何十GBもあるDBでも扱えるように、次のことを守る。
//! - 行は1件ずつ受け取りながら書き出す (全件をメモリに載せない)
//! - DBから読む処理と、ファイルへ書く処理を別々に動かして待ち時間を重ねる
//! - PostgreSQL は COPY で読み書きする (1行ずつのINSERTより桁違いに速い)
//! - 流し込みでは、ファイルを読んで文に分ける処理と、実行する処理を別々に動かす

pub mod mysql;
pub mod pg;
pub mod restore;
pub mod split;
pub mod sql;
pub mod sqlite;
pub mod target;
#[cfg(test)]
mod tests;

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, watch};

use crate::models::{DbType, ExportTable};
use crate::query_log::QueryLog;
use crate::tools::{Endpoint, Jobs, StartedJob};

/// 1つの INSERT 文 (や1回に書き出すかたまり) の大きさの目安。
///
/// mysqldump の既定 (net_buffer_length) と同じくらいにしておく。
/// 大きすぎると、流し込む側の max_allowed_packet に引っかかる
pub const CHUNK: usize = 1024 * 1024;

/// 何を書き出すか
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// 定義とデータ
    Full,
    /// 定義だけ
    Schema,
    /// データだけ
    Data,
}

impl Mode {
    pub fn parse(s: &str) -> Mode {
        match s {
            "schema" => Mode::Schema,
            "data" => Mode::Data,
            _ => Mode::Full,
        }
    }
    /// 定義を書くか
    pub fn ddl(self) -> bool {
        self != Mode::Data
    }
    /// データを書くか
    pub fn rows(self) -> bool {
        self != Mode::Schema
    }
}

/**
 * 書き出し・流し込みの進み具合。
 *
 * 書き出しでは、テーブルごとの大きさ (サーバーの見積もり) を重みにして、
 * 「終わったテーブルの重み + 今のテーブルの重み × 読んだ行数 / 見積もり行数」で全体を測る。
 * 行数の見積もりは外れることがあるので、テーブルが終わるまでは 99% で止める。
 * 流し込みでは、ファイルのどこまで実行し終えたかで測る
 */
pub struct Progress {
    /// 書き出したバイト数 / 流し込み終えたバイト数
    bytes: AtomicU64,
    total: AtomicU64,
    done: AtomicU64,
    cur_weight: AtomicU64,
    cur_rows: AtomicU64,
    cur_est: AtomicU64,
    stage: std::sync::Mutex<String>,
    notes: std::sync::Mutex<Vec<String>>,
    stop: watch::Sender<bool>,
}

impl Default for Progress {
    fn default() -> Self {
        Progress {
            bytes: AtomicU64::new(0),
            total: AtomicU64::new(0),
            done: AtomicU64::new(0),
            cur_weight: AtomicU64::new(0),
            cur_rows: AtomicU64::new(0),
            cur_est: AtomicU64::new(0),
            stage: std::sync::Mutex::new(String::new()),
            notes: std::sync::Mutex::new(Vec::new()),
            stop: watch::channel(false).0,
        }
    }
}

impl Progress {
    pub fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }
    pub fn add_bytes(&self, n: u64) {
        self.bytes.fetch_add(n, Ordering::Relaxed);
    }
    pub fn set_bytes(&self, n: u64) {
        self.bytes.store(n, Ordering::Relaxed);
    }
    /// 全体の重み
    pub fn set_total(&self, total: u64) {
        self.total.store(total, Ordering::Relaxed);
    }
    /// 終わったところまでの重みを直接決める (流し込みで使う)
    pub fn set_done(&self, done: u64) {
        self.done.store(done, Ordering::Relaxed);
    }
    /// 1つのテーブル (などのかたまり) に取りかかる
    pub fn begin(&self, weight: u64, est_rows: u64) {
        self.cur_rows.store(0, Ordering::Relaxed);
        self.cur_est.store(est_rows, Ordering::Relaxed);
        self.cur_weight.store(weight, Ordering::Relaxed);
    }
    /// 今のテーブルで読んだ行を足す
    pub fn add_rows(&self, n: u64) {
        self.cur_rows.fetch_add(n, Ordering::Relaxed);
    }
    /// 今のテーブルが終わった
    pub fn end(&self) {
        let w = self.cur_weight.swap(0, Ordering::Relaxed);
        self.done.fetch_add(w, Ordering::Relaxed);
        self.cur_rows.store(0, Ordering::Relaxed);
        self.cur_est.store(0, Ordering::Relaxed);
    }
    /// 全体のどこまで進んだか (0〜1)
    pub fn fraction(&self) -> Option<f64> {
        let total = self.total.load(Ordering::Relaxed);
        if total == 0 {
            return None;
        }
        let done = self.done.load(Ordering::Relaxed) as f64;
        let weight = self.cur_weight.load(Ordering::Relaxed) as f64;
        let est = self.cur_est.load(Ordering::Relaxed);
        let part = if est == 0 {
            0.0
        } else {
            (self.cur_rows.load(Ordering::Relaxed) as f64 / est as f64).min(0.99)
        };
        Some(((done + weight * part) / total as f64).clamp(0.0, 1.0))
    }
    pub fn set_stage(&self, s: impl Into<String>) {
        *self.stage.lock().unwrap_or_else(|e| e.into_inner()) = s.into();
    }
    pub fn stage(&self) -> Option<String> {
        let s = self.stage.lock().unwrap_or_else(|e| e.into_inner()).clone();
        (!s.is_empty()).then_some(s)
    }
    /// 終わったときに知らせたいこと (同じものは1回だけ残す)
    pub fn note(&self, s: impl Into<String>) {
        let s = s.into();
        let mut notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
        if !notes.contains(&s) {
            notes.push(s);
        }
    }
    pub fn notes(&self) -> Vec<String> {
        self.notes.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    /// 止めるよう頼む (キャンセルボタン)
    pub fn stop(&self) {
        self.stop.send_replace(true);
    }
    pub fn stopped(&self) -> bool {
        *self.stop.borrow()
    }
    /**
     * 待っている処理を、キャンセルされたら打ち切る。
     *
     * 1つの文が何分もかかることがある (大きなテーブルへのインデックス作成など) ので、
     * 文の切れ目を待たずに止められるようにする
     */
    pub async fn guard<T>(&self, fut: impl std::future::Future<Output = T>) -> Result<T, String> {
        if self.stopped() {
            return Err(CANCELLED.into());
        }
        let mut rx = self.stop.subscribe();
        tokio::select! {
            v = fut => Ok(v),
            _ = rx.wait_for(|v| *v) => Err(CANCELLED.into()),
        }
    }
}

pub const CANCELLED: &str = "キャンセルされました";

/**
 * 書き出し先のファイル。
 *
 * 書く処理は別のスレッドで動かし、DBから読む側は渡すだけにする。
 * 渡せる量に上限を付けて、ディスクが遅いときにメモリが膨らまないようにする
 */
pub struct Out {
    tx: Option<mpsc::Sender<Vec<u8>>>,
    handle: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Out {
    pub fn new(file: std::fs::File, progress: Arc<Progress>) -> Out {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(8);
        let handle = tokio::task::spawn_blocking(move || {
            let mut w = std::io::BufWriter::with_capacity(4 * CHUNK, file);
            while let Some(buf) = rx.blocking_recv() {
                w.write_all(&buf)?;
                progress.add_bytes(buf.len() as u64);
            }
            let file = w.into_inner().map_err(|e| e.into_error())?;
            // 書き終えたことを確かめてから「完了」にする
            file.sync_all()
        });
        Out {
            tx: Some(tx),
            handle,
        }
    }

    /// ためたかたまりを書き出しに回す (空なら何もしない)
    pub async fn write(&mut self, buf: &mut Vec<u8>) -> Result<(), String> {
        if buf.is_empty() {
            return Ok(());
        }
        let data = std::mem::replace(buf, Vec::with_capacity(CHUNK + CHUNK / 4));
        let tx = self.tx.as_ref().ok_or("書き出しは終わっています")?;
        if tx.send(data).await.is_err() {
            return Err("ファイルへ書き込めませんでした".into());
        }
        Ok(())
    }

    /// 文字をそのまま書く
    pub async fn text(&mut self, s: &str) -> Result<(), String> {
        let mut buf = s.as_bytes().to_vec();
        self.write(&mut buf).await
    }

    /// 書き終える (ディスクに書けたことまで待つ)
    pub async fn finish(mut self) -> Result<(), String> {
        self.tx.take();
        match self.handle.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(format!("ファイルへ書き込めませんでした: {e}")),
            Err(e) => Err(format!("ファイルへ書き込めませんでした: {e}")),
        }
    }
}

/// SQLコンソールに経過を残す
fn log(app: &AppHandle, label: &str, database: &str, text: &str) {
    app.state::<QueryLog>().add(label, database, text);
}

/// 時間の目安 (「3分12秒」のような形)
fn elapsed_label(d: std::time::Duration) -> String {
    let s = d.as_secs();
    if s >= 3600 {
        format!("{}時間{}分", s / 3600, s % 3600 / 60)
    } else if s >= 60 {
        format!("{}分{}秒", s / 60, s % 60)
    } else {
        format!("{s}秒")
    }
}

/// 選んだテーブルを、Quelio自身でSQLファイルへ書き出す
pub async fn start_export(
    app: &AppHandle,
    jobs: &Jobs,
    ep: Endpoint,
    database: String,
    tables: Vec<ExportTable>,
    mode: String,
    out_path: Option<String>,
) -> Result<StartedJob, String> {
    if ep.db_type == DbType::Valkey {
        return Err("この接続ではSQLダンプの出力は使えません".into());
    }
    if tables.is_empty() {
        return Err("書き出すテーブルを選んでください".into());
    }
    let mode = Mode::parse(&mode);
    let out_path = target::resolve(app, &ep, &database, out_path.as_deref())?;
    // 途中は隣の .partial に書き、終わってから置き換える (古いバックアップを壊さない)
    // ダンプはDBの中身そのものなので、所有者だけが読める権限で作る
    let file = crate::outfile::create(&target::partial_path(&out_path))
        .map_err(|e| format!("出力ファイルを作成できません: {e}"))?;

    let progress = Arc::new(Progress::default());
    let job_id = crate::tools::register_native(
        jobs,
        "export",
        None,
        Some(out_path.clone()),
        progress.clone(),
    )
    .await;

    let app2 = app.clone();
    let jobs2 = jobs.clone();
    let id2 = job_id.clone();
    let path2 = out_path.clone();
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        log(
            &app2,
            &ep.label,
            &database,
            &format!("-- SQLダンプ出力を開始 (Quelio): {}テーブル → {}", tables.len(), path2.display()),
        );
        let mut out = Out::new(file, progress.clone());
        let res = match ep.db_type {
            DbType::Mysql => mysql::export(&ep, &database, &tables, mode, &progress, &mut out).await,
            DbType::Postgresql => pg::export(&ep, &database, &tables, mode, &progress, &mut out).await,
            DbType::Sqlite => sqlite::export(&ep, &tables, mode, &progress, &mut out).await,
            DbType::Valkey => Err("この接続ではSQLダンプの出力は使えません".into()),
        };
        let res = match res {
            Ok(()) => match out.finish().await {
                Ok(()) => target::commit(&path2),
                Err(e) => Err(e),
            },
            Err(e) => {
                let _ = out.finish().await;
                Err(e)
            }
        };
        match &res {
            Ok(()) => {
                progress.set_stage("");
                log(
                    &app2,
                    &ep.label,
                    &database,
                    &format!(
                        "-- SQLダンプ出力が完了 ({} / {})",
                        crate::dump::sql::size_label(progress.bytes()),
                        elapsed_label(started.elapsed())
                    ),
                );
            }
            Err(e) => {
                // 途中までのファイルを、完全なバックアップと取り違えないように消す
                target::discard(&path2);
                log(&app2, &ep.label, &database, &format!("-- SQLダンプ出力を中断: {e}"));
            }
        }
        crate::tools::finish_native(&jobs2, &id2, res).await;
    });

    Ok(StartedJob {
        job_id,
        out_path: Some(out_path.to_string_lossy().to_string()),
    })
}

/// SQLファイルを、Quelio自身で1文ずつ実行する
pub async fn start_import(
    app: &AppHandle,
    jobs: &Jobs,
    ep: Endpoint,
    database: String,
    file_path: String,
) -> Result<StartedJob, String> {
    // D&Dで受け取った一時ファイルなら、取り込みが終わった時点で消す
    let temp_file = crate::uploads::dir(app)
        .ok()
        .is_some_and(|d| crate::uploads::is_inside(&d, std::path::Path::new(&file_path)));
    let fail = |msg: String| -> String {
        if temp_file {
            let _ = std::fs::remove_file(&file_path);
        }
        msg
    };
    if ep.read_only {
        return Err(fail(
            "この接続は読み取り専用です。SQLファイルの取り込みはできません。".to_string(),
        ));
    }
    if ep.db_type == DbType::Valkey {
        return Err(fail("この接続ではSQLファイルの実行は使えません".to_string()));
    }
    let total = std::fs::metadata(&file_path)
        .map_err(|e| fail(format!("ファイルを読み込めません: {e}")))?
        .len();

    let progress = Arc::new(Progress::default());
    let job_id =
        crate::tools::register_native(jobs, "import", Some(total), None, progress.clone()).await;

    let app2 = app.clone();
    let jobs2 = jobs.clone();
    let id2 = job_id.clone();
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let path = PathBuf::from(&file_path);
        log(
            &app2,
            &ep.label,
            &database,
            &format!("-- SQLファイルの実行を開始 (Quelio): {}", path.display()),
        );
        let res = restore::run(&ep, &database, &path, &progress).await;
        if temp_file {
            let _ = tokio::fs::remove_file(&path).await;
        }
        match &res {
            Ok(n) => {
                progress.set_stage("");
                log(
                    &app2,
                    &ep.label,
                    &database,
                    &format!(
                        "-- SQLファイルの実行が完了 ({}文 / {})",
                        n,
                        elapsed_label(started.elapsed())
                    ),
                );
            }
            Err(e) => log(&app2, &ep.label, &database, &format!("-- SQLファイルの実行を中断: {e}")),
        }
        crate::tools::finish_native(&jobs2, &id2, res.map(|_| ())).await;
    });

    Ok(StartedJob {
        job_id,
        out_path: None,
    })
}
