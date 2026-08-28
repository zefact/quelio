use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::models::DbType;

/// 外部ツール(mysqldump等)のパス設定。空文字は「自動検出」を意味する
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSettings {
    #[serde(default)]
    pub mysqldump: String,
    #[serde(default)]
    pub mysql: String,
    #[serde(default)]
    pub pg_dump: String,
    #[serde(default)]
    pub psql: String,
}

/// 1ツールの検出結果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub tool: String,
    pub path: Option<String>,
    pub version: Option<String>,
    /// 設定で指定されたパスか (falseなら自動検出)
    pub from_settings: bool,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    crate::json_store::config_path(app, "tools.json")
}

pub fn load_settings(app: &AppHandle) -> Result<ToolSettings, String> {
    let path = settings_path(app)?;
    Ok(crate::json_store::read(&path, "設定")?.unwrap_or_default())
}

pub fn save_settings(app: &AppHandle, settings: &ToolSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let text = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("設定のシリアライズに失敗: {e}"))?;
    crate::json_store::write(&path, &text, "設定")
}

/// パスが通っていない場所にも入りがちなので、決まった場所も見に行く。
///
/// macOS は Homebrew / MacPorts / Postgres.app、
/// Linux はディストリビューションの標準的な置き場所。
/// Windows は場所がバージョン付きフォルダなので、下の関数で組み立てる
const FIXED_DIRS: &[&str] = &[
    // macOS
    "/opt/homebrew/bin",
    "/opt/homebrew/opt/mysql-client/bin",
    "/opt/homebrew/opt/libpq/bin",
    "/usr/local/opt/mysql-client/bin",
    "/usr/local/opt/libpq/bin",
    "/usr/local/mysql/bin",
    "/opt/local/bin",
    "/Applications/Postgres.app/Contents/Versions/latest/bin",
    // Linux / 共通
    "/usr/local/bin",
    "/usr/bin",
    "/usr/local/pgsql/bin",
    "/opt/mysql/bin",
    "/snap/bin",
];

/// Windows: `Program Files` の下の、バージョンごとに分かれたフォルダの bin。
///
/// 例) `C:\Program Files\PostgreSQL\16\bin`,
///     `C:\Program Files\MySQL\MySQL Server 8.0\bin`
///
/// 環境変数が無いOS (macOS / Linux) では空になるので、
/// プラットフォームで分けずに同じコードのままにしている
fn program_files_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let roots = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"];
    for root in roots.iter().filter_map(std::env::var_os) {
        let root = PathBuf::from(root);
        for vendor in ["PostgreSQL", "MySQL"] {
            // 中のフォルダは名前が版によって変わるので、あるものを全部見る
            let Ok(entries) = std::fs::read_dir(root.join(vendor)) else {
                continue;
            };
            for e in entries.flatten() {
                out.push(e.path().join("bin"));
            }
        }
        out.push(root.join("MariaDB").join("bin"));
    }
    out
}

/// 自動検出で探す場所を、見に行く順に並べて返す。
///
/// まず PATH (利用者が自分で通した場所が最優先)、
/// 次に決まった場所、最後に Windows のインストール先
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(FIXED_DIRS.iter().map(PathBuf::from));
    dirs.extend(program_files_dirs());
    dirs
}

/// 設定パス優先でツールの実体を探す
fn find_tool(configured: &str, name: &str) -> (Option<PathBuf>, bool) {
    let c = configured.trim();
    if !c.is_empty() {
        let p = PathBuf::from(c);
        return (p.is_file().then_some(p), true);
    }
    for dir in search_dirs() {
        // Windowsは実行ファイルに .exe が付く
        for file in [name.to_string(), format!("{name}.exe")] {
            let p = Path::new(&dir).join(file);
            if p.is_file() {
                return (Some(p), false);
            }
        }
    }
    (None, false)
}

async fn tool_version(path: &Path) -> Option<String> {
    let out = Command::new(path).arg("--version").output().await.ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().next().map(|l| l.trim().to_string())
}

/// 4ツールすべての検出状況を返す (設定画面用)
pub async fn detect_tools(app: &AppHandle) -> Result<Vec<ToolStatus>, String> {
    let settings = load_settings(app)?;
    let mut out = Vec::new();
    for (name, configured) in [
        ("mysqldump", &settings.mysqldump),
        ("mysql", &settings.mysql),
        ("pg_dump", &settings.pg_dump),
        ("psql", &settings.psql),
    ] {
        let (path, from_settings) = find_tool(configured, name);
        let version = match &path {
            Some(p) => tool_version(p).await,
            None => None,
        };
        out.push(ToolStatus {
            tool: name.to_string(),
            path: path.map(|p| p.to_string_lossy().to_string()),
            version,
            from_settings,
        });
    }
    Ok(out)
}

/// ツールのパスを解決する (見つからなければ設定を促すエラー)
fn require_tool(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let settings = load_settings(app)?;
    let configured = match name {
        "mysqldump" => &settings.mysqldump,
        "mysql" => &settings.mysql,
        "pg_dump" => &settings.pg_dump,
        "psql" => &settings.psql,
        _ => return Err(format!("不明なツール: {name}")),
    };
    let (path, _) = find_tool(configured, name);
    path.ok_or_else(|| {
        format!(
            concat!(
                "{name} が見つかりません。",
                "設定画面でパスを指定するか、インストールしてください\n",
                "macOS: brew install mysql-client libpq\n",
                "Linux: パッケージ管理から mysql-client / postgresql-client\n",
                "Windows: MySQL / PostgreSQL のインストーラ",
                " (Program Files の下は自動で探します)"
            ),
            name = name
        )
    })
}

// ---------- ジョブ管理 ----------

pub struct Job {
    pub kind: String,
    pub done: bool,
    pub error: Option<String>,
    /// 処理済みバイト数 (インポート時に更新。エクスポートは出力ファイルサイズを見る)
    pub bytes: Arc<AtomicU64>,
    pub total: Option<u64>,
    pub out_path: Option<PathBuf>,
    child: Option<Arc<Mutex<Child>>>,
    pub cancelled: bool,
}

/// ジョブID → 状態 (Tauriのmanaged state)。
/// 完了監視タスクから更新できるようArcで共有する
#[derive(Default, Clone)]
pub struct Jobs(pub Arc<Mutex<HashMap<String, Job>>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub running: bool,
    pub error: Option<String>,
    pub bytes: u64,
    pub total: Option<u64>,
    pub out_path: Option<String>,
    pub cancelled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedJob {
    pub job_id: String,
    pub out_path: Option<String>,
}

/// 接続エンドポイント情報 (sessions側で組み立てる)
pub struct Endpoint {
    pub db_type: DbType,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    /// 読み取り専用の接続か (インポートを止めるために見る)
    pub read_only: bool,
}

/// エクスポート/インポートの共通スポーン処理。
/// 終了待ちのタスクを起動し、stderrの末尾をエラーとして記録する。
async fn spawn_watched(
    jobs: Jobs,
    job_id: String,
    mut child: Child,
    feeder: Option<tokio::task::JoinHandle<Result<(), String>>>,
) {
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    {
        let mut map = jobs.0.lock().await;
        if let Some(j) = map.get_mut(&job_id) {
            j.child = Some(child.clone());
        }
    }
    tokio::spawn(async move {
        // stderrを読み切る (パスワード警告などのノイズは後で除外)
        let mut err_text = String::new();
        if let Some(mut e) = stderr {
            let mut buf = Vec::new();
            let _ = e.read_to_end(&mut buf).await;
            err_text = String::from_utf8_lossy(&buf).to_string();
        }
        // stdin供給タスクの失敗も拾う
        let feed_err = match feeder {
            Some(h) => h.await.ok().and_then(|r| r.err()),
            None => None,
        };
        let status = child.lock().await.wait().await;

        let mut map = jobs.0.lock().await;
        if let Some(j) = map.get_mut(&job_id) {
            j.done = true;
            // 終わったプロセスのハンドルは持ち続けない
            j.child = None;
            if j.cancelled {
                j.error = Some("キャンセルされました".to_string());
                return;
            }
            let significant: Vec<&str> = err_text
                .lines()
                .filter(|l| {
                    let l = l.trim();
                    !l.is_empty() && !l.contains("Using a password") && !l.contains("[Warning]")
                })
                .collect();
            match status {
                Ok(s) if s.success() => {
                    if let Some(fe) = feed_err {
                        j.error = Some(fe);
                    }
                }
                Ok(s) => {
                    let detail = if significant.is_empty() {
                        format!("終了コード {}", s.code().unwrap_or(-1))
                    } else {
                        significant.join("\n")
                    };
                    j.error = Some(detail);
                }
                Err(e) => j.error = Some(format!("プロセスの実行に失敗: {e}")),
            }
        }
    });
}

/// 終わったジョブを片付ける (新しいジョブを始めるときに呼ぶ)。
/// 実行中のジョブは残す。完了したジョブの結果は画面側が保持している
fn drop_finished(map: &mut HashMap<String, Job>) {
    let finished: Vec<String> = map
        .iter()
        .filter(|(_, j)| j.done)
        .map(|(id, _)| id.clone())
        .collect();
    for id in finished {
        map.remove(&id);
    }
}

fn new_job(kind: &str, total: Option<u64>, out_path: Option<PathBuf>) -> (String, Job) {
    let id = uuid::Uuid::new_v4().to_string();
    let job = Job {
        kind: kind.to_string(),
        done: false,
        error: None,
        bytes: Arc::new(AtomicU64::new(0)),
        total,
        out_path,
        child: None,
        cancelled: false,
    };
    (id, job)
}

/// 選択テーブルをSQLファイルへエクスポートする
pub async fn start_export(
    app: &AppHandle,
    jobs: &Jobs,
    ep: Endpoint,
    database: String,
    tables: Vec<crate::models::ExportTable>,
    mode: String, // full | schema | data
) -> Result<StartedJob, String> {
    // 使えない接続は、空のファイルを残さないよう先に断る
    if matches!(ep.db_type, DbType::Valkey | DbType::Sqlite) {
        return Err("この接続ではSQLダンプの出力・実行は使えません".into());
    }
    // 設定の「保存先フォルダ」に従う (未設定ならOSのダウンロードフォルダ)
    let dir = crate::app_settings::download_dir(app)?;
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
    // DB名はユーザーが決めるものなので、そのままファイル名にしない
    let stem = crate::filename::safe_stem(&database);
    let out_path = dir.join(format!("{stem}_{ts}.sql"));
    // ダンプはDBの中身そのものなので、所有者だけが読める権限で作る
    let out_file = crate::outfile::create(&out_path)
        .map_err(|e| format!("出力ファイルを作成できません: {e}"))?;
    let mut cmd = match ep.db_type {
        DbType::Valkey | DbType::Sqlite => unreachable!(),
        DbType::Mysql => {
            let tool = require_tool(app, "mysqldump")?;
            let mut c = Command::new(tool);
            c.arg("-h")
                .arg(&ep.host)
                .arg("-P")
                .arg(ep.port.to_string())
                .arg("-u")
                .arg(&ep.user)
                .arg("--single-transaction")
                .arg("--no-tablespaces");
            match mode.as_str() {
                "schema" => {
                    c.arg("--no-data").arg("--triggers").arg("--routines");
                }
                "data" => {
                    c.arg("--no-create-info").arg("--skip-triggers");
                }
                _ => {
                    c.arg("--triggers").arg("--routines");
                }
            }
            // ここから先はオプションではなく名前として渡す
            // (`-` で始まるDB名・テーブル名をオプションと誤解させない)
            c.arg("--");
            c.arg(&database);
            for t in &tables {
                c.arg(&t.name);
            }
            c.env("MYSQL_PWD", &ep.password);
            c
        }
        DbType::Postgresql => {
            let tool = require_tool(app, "pg_dump")?;
            let mut c = Command::new(tool);
            c.arg("-h")
                .arg(&ep.host)
                .arg("-p")
                .arg(ep.port.to_string())
                .arg("-U")
                .arg(&ep.user)
                .arg("-d")
                .arg(&database)
                .arg("--no-password");
            match mode.as_str() {
                "schema" => {
                    c.arg("--schema-only");
                }
                "data" => {
                    c.arg("--data-only");
                }
                _ => {}
            }
            for t in &tables {
                // -t はワイルドカードのパターンなので、名前として扱わせる
                c.arg("-t")
                    .arg(crate::filename::pg_table_pattern(t.schema.as_deref(), &t.name));
            }
            c.env("PGPASSWORD", &ep.password);
            c
        }
    };

    let child = cmd
        .stdout(std::process::Stdio::from(out_file))
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("プロセスを起動できません: {e}"))?;

    let (job_id, job) = new_job("export", None, Some(out_path.clone()));
    {
        let mut map = jobs.0.lock().await;
        drop_finished(&mut map);
        map.insert(job_id.clone(), job);
    }
    spawn_watched(jobs.clone(), job_id.clone(), child, None).await;

    Ok(StartedJob {
        job_id,
        out_path: Some(out_path.to_string_lossy().to_string()),
    })
}

/// SQLファイルを実行(インポート)する
pub async fn start_import(
    app: &AppHandle,
    jobs: &Jobs,
    ep: Endpoint,
    database: String,
    file_path: String,
) -> Result<StartedJob, String> {
    // D&Dで受け取った一時ファイルなら、取り込みが終わった時点で消す
    // (ユーザーが自分で選んだファイルは消さない)
    let temp_file = crate::uploads::dir(app)
        .ok()
        .is_some_and(|d| crate::uploads::is_inside(&d, std::path::Path::new(&file_path)));
    // 途中で失敗したときも一時ファイルを残さないためのヘルパー
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
    let total = std::fs::metadata(&file_path)
        .map_err(|e| fail(format!("ファイルを読み込めません: {e}")))?
        .len();

    if matches!(ep.db_type, DbType::Valkey | DbType::Sqlite) {
        return Err(fail(
            "この接続ではSQLダンプの出力・実行は使えません".to_string(),
        ));
    }
    let mut cmd = match ep.db_type {
        DbType::Valkey | DbType::Sqlite => unreachable!(),
        DbType::Mysql => {
            let tool = require_tool(app, "mysql").map_err(&fail)?;
            let mut c = Command::new(tool);
            c.arg("-h")
                .arg(&ep.host)
                .arg("-P")
                .arg(ep.port.to_string())
                .arg("-u")
                .arg(&ep.user)
                .arg("--")
                .arg(&database);
            c.env("MYSQL_PWD", &ep.password);
            c
        }
        DbType::Postgresql => {
            let tool = require_tool(app, "psql").map_err(&fail)?;
            let mut c = Command::new(tool);
            c.arg("-h")
                .arg(&ep.host)
                .arg("-p")
                .arg(ep.port.to_string())
                .arg("-U")
                .arg(&ep.user)
                .arg("-d")
                .arg(&database)
                .arg("--no-password")
                .arg("-v")
                .arg("ON_ERROR_STOP=1")
                .arg("-q");
            c.env("PGPASSWORD", &ep.password);
            c
        }
    };

    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| fail(format!("プロセスを起動できません: {e}")))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| fail("標準入力を取得できません".to_string()))?;

    let (job_id, job) = new_job("import", Some(total), None);
    let bytes = job.bytes.clone();
    {
        let mut map = jobs.0.lock().await;
        drop_finished(&mut map);
        map.insert(job_id.clone(), job);
    }

    // ファイルをチャンクで流し込みつつ進捗を更新する
    let feeder = tokio::spawn(async move {
        let path = file_path.clone();
        let result = async move {
            let mut f = tokio::fs::File::open(&file_path)
                .await
                .map_err(|e| format!("ファイルを開けません: {e}"))?;
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                let n = f
                    .read(&mut buf)
                    .await
                    .map_err(|e| format!("ファイルの読み込みに失敗: {e}"))?;
                if n == 0 {
                    break;
                }
                if stdin.write_all(&buf[..n]).await.is_err() {
                    // プロセス側が終了した (エラーはstderr側で報告される)
                    return Ok(());
                }
                bytes.fetch_add(n as u64, Ordering::Relaxed);
            }
            let _ = stdin.shutdown().await;
            Ok(())
        }
        .await;
        if temp_file {
            let _ = tokio::fs::remove_file(&path).await;
        }
        result
    });

    spawn_watched(jobs.clone(), job_id.clone(), child, Some(feeder)).await;
    Ok(StartedJob {
        job_id,
        out_path: None,
    })
}

pub async fn job_status(jobs: &Jobs, job_id: &str) -> Result<JobStatus, String> {
    // 必要な値を写し取ってからロックを手放す
    // (ファイルサイズの取得は同期処理なので、ロックを持ったまま行わない)
    let (kind, done, error, counted, total, out_path, cancelled) = {
        let map = jobs.0.lock().await;
        let j = map.get(job_id).ok_or("ジョブが見つかりません")?;
        (
            j.kind.clone(),
            j.done,
            j.error.clone(),
            j.bytes.load(Ordering::Relaxed),
            j.total,
            j.out_path.clone(),
            j.cancelled,
        )
    };
    let bytes = if kind == "export" {
        out_path
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        counted
    };
    Ok(JobStatus {
        running: !done,
        error,
        bytes,
        total,
        out_path: out_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        cancelled,
    })
}

pub async fn cancel_job(jobs: &Jobs, job_id: &str) -> Result<(), String> {
    let child = {
        let mut map = jobs.0.lock().await;
        let j = map.get_mut(job_id).ok_or("ジョブが見つかりません")?;
        if j.done {
            return Ok(());
        }
        j.cancelled = true;
        j.child.clone()
    };
    if let Some(c) = child {
        let _ = c.lock().await.kill().await;
    }
    Ok(())
}
