use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
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
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定ディレクトリを取得できません: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("設定ディレクトリを作成できません: {e}"))?;
    Ok(dir.join("tools.json"))
}

pub fn load_settings(app: &AppHandle) -> Result<ToolSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(ToolSettings::default());
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("設定を読み込めません: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("設定の形式が不正です: {e}"))
}

pub fn save_settings(app: &AppHandle, settings: &ToolSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let text = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("設定のシリアライズに失敗: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("設定を書き込めません: {e}"))
}

/// 自動検出の探索ディレクトリ (Homebrew / MacPorts / Postgres.app / システム標準)
const SEARCH_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/opt/mysql-client/bin",
    "/opt/homebrew/opt/libpq/bin",
    "/usr/local/bin",
    "/usr/local/opt/mysql-client/bin",
    "/usr/local/opt/libpq/bin",
    "/usr/local/mysql/bin",
    "/opt/local/bin",
    "/Applications/Postgres.app/Contents/Versions/latest/bin",
    "/usr/bin",
];

/// 設定パス優先でツールの実体を探す
fn find_tool(configured: &str, name: &str) -> (Option<PathBuf>, bool) {
    let c = configured.trim();
    if !c.is_empty() {
        let p = PathBuf::from(c);
        return (p.is_file().then_some(p), true);
    }
    for dir in SEARCH_DIRS {
        let p = Path::new(dir).join(name);
        if p.is_file() {
            return (Some(p), false);
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
        format!("{name} が見つかりません。設定画面でパスを指定するか、インストールしてください (例: brew install mysql-client / libpq)")
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
    tables: Vec<String>,
    mode: String, // full | schema | data
) -> Result<StartedJob, String> {
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("保存先フォルダを取得できません: {e}"))?;
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let out_path = dir.join(format!("{database}_{ts}.sql"));
    let out_file = std::fs::File::create(&out_path)
        .map_err(|e| format!("出力ファイルを作成できません: {e}"))?;

    if ep.db_type == DbType::Valkey {
        return Err("Valkey接続ではエクスポート/インポートは使用できません".into());
    }
    let mut cmd = match ep.db_type {
        DbType::Valkey => unreachable!(),
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
            c.arg(&database);
            for t in &tables {
                c.arg(t);
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
                c.arg("-t").arg(t);
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
    jobs.0.lock().await.insert(job_id.clone(), job);
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
    let total = std::fs::metadata(&file_path)
        .map_err(|e| format!("ファイルを読み込めません: {e}"))?
        .len();

    if ep.db_type == DbType::Valkey {
        return Err("Valkey接続ではエクスポート/インポートは使用できません".into());
    }
    let mut cmd = match ep.db_type {
        DbType::Valkey => unreachable!(),
        DbType::Mysql => {
            let tool = require_tool(app, "mysql")?;
            let mut c = Command::new(tool);
            c.arg("-h")
                .arg(&ep.host)
                .arg("-P")
                .arg(ep.port.to_string())
                .arg("-u")
                .arg(&ep.user)
                .arg(&database);
            c.env("MYSQL_PWD", &ep.password);
            c
        }
        DbType::Postgresql => {
            let tool = require_tool(app, "psql")?;
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
        .map_err(|e| format!("プロセスを起動できません: {e}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or("標準入力を取得できません")?;

    let (job_id, job) = new_job("import", Some(total), None);
    let bytes = job.bytes.clone();
    jobs.0.lock().await.insert(job_id.clone(), job);

    // ファイルをチャンクで流し込みつつ進捗を更新する
    let feeder = tokio::spawn(async move {
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
    });

    spawn_watched(jobs.clone(), job_id.clone(), child, Some(feeder)).await;
    Ok(StartedJob {
        job_id,
        out_path: None,
    })
}

pub async fn job_status(jobs: &Jobs, job_id: &str) -> Result<JobStatus, String> {
    let map = jobs.0.lock().await;
    let j = map.get(job_id).ok_or("ジョブが見つかりません")?;
    let bytes = if j.kind == "export" {
        j.out_path
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        j.bytes.load(Ordering::Relaxed)
    };
    Ok(JobStatus {
        running: !j.done,
        error: j.error.clone(),
        bytes,
        total: j.total,
        out_path: j.out_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        cancelled: j.cancelled,
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
