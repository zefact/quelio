use tauri::{AppHandle, Manager, State};

use crate::models::{
    ConnectInfo, ConnectionProfile, ConnectionStore, FolderInfo, LayoutEntry, RunOutput,
    SchemaEntry, SessionSummary, TableDetail, TableInfo, TestResult,
};
use crate::query_log::{QueryLog, QueryLogEntry};
use crate::sessions::{self, CancelRegistry, Sessions};
use crate::tools::{self, JobStatus, Jobs, StartedJob, ToolSettings, ToolStatus};
use crate::{db, storage};

/// 保存済みの接続先一式(フォルダ+接続)を返す
#[tauri::command]
pub fn list_connections(app: AppHandle) -> Result<ConnectionStore, String> {
    storage::load(&app)
}

/// 接続プロファイルを保存(idが空なら新規採番)して保存後のものを返す
#[tauri::command]
pub fn save_connection(
    app: AppHandle,
    mut profile: ConnectionProfile,
) -> Result<ConnectionProfile, String> {
    let mut store = storage::load(&app)?;

    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
        store.connections.push(profile.clone());
    } else if let Some(slot) = store.connections.iter_mut().find(|c| c.id == profile.id) {
        *slot = profile.clone();
    } else {
        store.connections.push(profile.clone());
    }

    storage::save(&app, &store)?;
    Ok(profile)
}

/// 接続プロファイルを削除
#[tauri::command]
pub fn delete_connection(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = storage::load(&app)?;
    store.connections.retain(|c| c.id != id);
    storage::save(&app, &store)
}

/// フォルダを作成して返す
#[tauri::command]
pub fn create_folder(app: AppHandle, name: String) -> Result<FolderInfo, String> {
    let mut store = storage::load(&app)?;
    let folder = FolderInfo {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        collapsed: false,
        color: None,
    };
    store.folders.push(folder.clone());
    storage::save(&app, &store)?;
    Ok(folder)
}

/// フォルダを削除する (中の接続はルート直下に移動)
#[tauri::command]
pub fn delete_folder(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = storage::load(&app)?;
    store.folders.retain(|f| f.id != id);
    for c in store.connections.iter_mut() {
        if c.folder_id.as_deref() == Some(id.as_str()) {
            c.folder_id = None;
        }
    }
    storage::save(&app, &store)
}

/// フォルダ一覧(名前・並び・折りたたみ)と接続の並び/所属を一括保存する
#[tauri::command]
pub fn update_layout(
    app: AppHandle,
    folders: Vec<FolderInfo>,
    order: Vec<LayoutEntry>,
) -> Result<(), String> {
    let mut store = storage::load(&app)?;
    store.folders = folders;

    // orderで指定された順に並べ替え、所属フォルダを反映する。
    // orderに含まれない接続は末尾に残す。
    let mut remaining = std::mem::take(&mut store.connections);
    let mut ordered = Vec::with_capacity(remaining.len());
    for entry in &order {
        if let Some(pos) = remaining.iter().position(|c| c.id == entry.id) {
            let mut conn = remaining.remove(pos);
            conn.folder_id = entry.folder_id.clone();
            ordered.push(conn);
        }
    }
    ordered.extend(remaining);
    store.connections = ordered;

    storage::save(&app, &store)
}

/// 接続テスト(未保存のプロファイルでも実行可能)
#[tauri::command]
pub async fn test_connection(
    qlog: State<'_, QueryLog>,
    profile: ConnectionProfile,
) -> Result<TestResult, String> {
    Ok(db::run_test(profile, &qlog).await)
}

/// 接続を確立し、データベース一覧を返す (session_idはタブ単位の任意キー)
#[tauri::command]
pub async fn connect_session(
    state: State<'_, Sessions>,
    cancel: State<'_, CancelRegistry>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    profile: ConnectionProfile,
) -> Result<ConnectInfo, String> {
    sessions::connect(&state, &cancel, &qlog, session_id, profile).await
}

/// 実行中のクエリをキャンセルする (別接続からKILL/pg_cancel_backend)
#[tauri::command]
pub async fn cancel_query(
    cancel: State<'_, CancelRegistry>,
    qlog: State<'_, QueryLog>,
    session_id: String,
) -> Result<(), String> {
    sessions::cancel_query(&cancel, &qlog, &session_id).await
}

/// 指定データベースのテーブル一覧を返す
#[tauri::command]
pub async fn list_tables(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
) -> Result<Vec<TableInfo>, String> {
    sessions::list_tables(&state, &qlog, &session_id, &database).await
}

/// テーブル構造(カラム・インデックス・情報)を返す
#[tauri::command]
pub async fn table_detail(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
    schema: Option<String>,
    table: String,
) -> Result<TableDetail, String> {
    sessions::table_detail(&state, &qlog, &session_id, &database, schema, &table).await
}

/// 選択中DBのスキーマ情報をCSV3ファイルでDownloadsに書き出し、パスを返す
#[tauri::command]
pub async fn export_schema_csv(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    let delim = crate::app_settings::load(&app)?.comment_delimiter;
    let (tables, columns, indexes) =
        sessions::export_schema(&state, &qlog, &session_id, &database, &delim).await?;

    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("保存先フォルダを取得できません: {e}"))?;
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");

    let mut paths = Vec::new();
    for (kind, content) in [
        ("tables", tables),
        ("columns", columns),
        ("indexes", indexes),
    ] {
        let path = dir.join(format!("{database}_{kind}_{ts}.csv"));
        std::fs::write(&path, content).map_err(|e| format!("CSVを書き込めません: {e}"))?;
        paths.push(path.to_string_lossy().to_string());
    }
    Ok(paths)
}

/// 実行結果キャプチャ(PNG)をDownloadsに保存し、パスを返す
#[tauri::command]
pub async fn save_capture(
    app: AppHandle,
    file_name: String,
    data_base64: String,
) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("画像データを解読できません: {e}"))?;
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("保存先フォルダを取得できません: {e}"))?;
    // パス区切り等を除去した安全なファイル名にする
    let safe: String = file_name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':') { '_' } else { c })
        .collect();
    let path = dir.join(safe);
    std::fs::write(&path, bytes).map_err(|e| format!("画像を書き込めません: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// アプリ全般の設定を返す
#[tauri::command]
pub fn get_app_settings(app: AppHandle) -> Result<crate::app_settings::AppSettings, String> {
    crate::app_settings::load(&app)
}

/// アプリ全般の設定を保存する
#[tauri::command]
pub fn save_app_settings(
    app: AppHandle,
    settings: crate::app_settings::AppSettings,
) -> Result<(), String> {
    crate::app_settings::save(&app, &settings)
}

// ---------- 外部ツール (エクスポート/インポート) ----------

/// D&Dされたファイルの受け皿となる一時ファイルを作成してパスを返す
#[tauri::command]
pub fn create_temp_upload(file_name: String) -> Result<String, String> {
    let safe: String = file_name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':') { '_' } else { c })
        .collect();
    let dir = std::env::temp_dir().join("quelio_uploads");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("一時フォルダを作成できません: {e}"))?;
    let path = dir.join(format!("{}_{safe}", uuid::Uuid::new_v4()));
    std::fs::File::create(&path).map_err(|e| format!("一時ファイルを作成できません: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 一時ファイルへチャンクを追記する (D&Dファイルの転送用)
#[tauri::command]
pub fn append_temp_upload(path: String, data_base64: String) -> Result<(), String> {
    use base64::Engine as _;
    use std::io::Write;
    let dir = std::env::temp_dir().join("quelio_uploads");
    let p = std::path::PathBuf::from(&path);
    if !p.starts_with(&dir) {
        return Err("不正なパスです".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("データを解読できません: {e}"))?;
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&p)
        .map_err(|e| format!("一時ファイルを開けません: {e}"))?;
    f.write_all(&bytes)
        .map_err(|e| format!("一時ファイルへ書き込めません: {e}"))
}

/// 外部ツールのパス設定を返す
#[tauri::command]
pub fn get_tool_settings(app: AppHandle) -> Result<ToolSettings, String> {
    tools::load_settings(&app)
}

/// 外部ツールのパス設定を保存する
#[tauri::command]
pub fn save_tool_settings(app: AppHandle, settings: ToolSettings) -> Result<(), String> {
    tools::save_settings(&app, &settings)
}

/// 外部ツールの検出状況を返す
#[tauri::command]
pub async fn detect_tools(app: AppHandle) -> Result<Vec<ToolStatus>, String> {
    tools::detect_tools(&app).await
}

/// 選択テーブルのエクスポートを開始する (mode: full | schema | data)
#[tauri::command]
pub async fn start_export(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, Jobs>,
    session_id: String,
    database: String,
    tables: Vec<String>,
    mode: String,
) -> Result<StartedJob, String> {
    let ep = sessions::endpoint_info(&state, &qlog, &session_id).await?;
    tools::start_export(&app, &jobs, ep, database, tables, mode).await
}

/// SQLファイルのインポートを開始する
#[tauri::command]
pub async fn start_import(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, Jobs>,
    session_id: String,
    database: String,
    file_path: String,
) -> Result<StartedJob, String> {
    let ep = sessions::endpoint_info(&state, &qlog, &session_id).await?;
    tools::start_import(&app, &jobs, ep, database, file_path).await
}

/// ジョブの進捗を返す
#[tauri::command]
pub async fn job_status(jobs: State<'_, Jobs>, job_id: String) -> Result<JobStatus, String> {
    tools::job_status(&jobs, &job_id).await
}

/// ジョブをキャンセルする
#[tauri::command]
pub async fn cancel_job(jobs: State<'_, Jobs>, job_id: String) -> Result<(), String> {
    tools::cancel_job(&jobs, &job_id).await
}

/// 開いているセッションの一覧 (差分ビューア用)
#[tauri::command]
pub async fn list_sessions(state: State<'_, Sessions>) -> Result<Vec<SessionSummary>, String> {
    Ok(sessions::list_sessions(&state).await)
}

/// 指定DBのスキーマスナップショットを返す (差分ビューア用)
#[tauri::command]
pub async fn schema_snapshot(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
) -> Result<Vec<SchemaEntry>, String> {
    sessions::schema_snapshot(&state, &qlog, &session_id, &database).await
}

/// URLクエリ用の簡易パーセントエンコード
fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// スキーマ一覧ウィンドウを開く(既にあればフォーカス)
#[tauri::command]
pub async fn open_schema(
    app: AppHandle,
    session_id: String,
    database: String,
) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("schema") {
        let _ = w.set_focus();
        return Ok(());
    }
    let url = format!(
        "index.html?schema=1&session={}&db={}",
        url_encode(&session_id),
        url_encode(&database)
    );
    let b = tauri::WebviewWindowBuilder::new(&app, "schema", tauri::WebviewUrl::App(url.into()))
        .title("Quelio — スキーマ一覧")
        .inner_size(1250.0, 780.0)
        .min_inner_size(800.0, 400.0);
    #[cfg(target_os = "macos")]
    let b = b
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 26.0));
    b.build()
        .map_err(|e| format!("スキーマ一覧を開けません: {e}"))?;
    Ok(())
}

/// スキーマ差分ウィンドウを開く(既にあればフォーカス)
#[tauri::command]
pub async fn open_diff(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("diff") {
        let _ = w.set_focus();
        return Ok(());
    }
    let b = tauri::WebviewWindowBuilder::new(
        &app,
        "diff",
        tauri::WebviewUrl::App("index.html?diff=1".into()),
    )
    .title("Quelio — スキーマ差分")
    .inner_size(1200.0, 760.0)
    .min_inner_size(800.0, 400.0);
    #[cfg(target_os = "macos")]
    let b = b
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 26.0));
    b.build()
        .map_err(|e| format!("差分ウィンドウを開けません: {e}"))?;
    Ok(())
}

/// クエリログを返す (after_seqより新しいもの。0で全件)
#[tauri::command]
pub fn get_query_log(
    qlog: State<'_, QueryLog>,
    after_seq: u64,
) -> Result<Vec<QueryLogEntry>, String> {
    Ok(qlog.entries_after(after_seq))
}

/// クエリログを消去する
#[tauri::command]
pub fn clear_query_log(qlog: State<'_, QueryLog>) -> Result<(), String> {
    qlog.clear();
    Ok(())
}

/// コンソールウィンドウを開く(既にあればフォーカス)
#[tauri::command]
pub async fn open_console(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("console") {
        let _ = w.set_focus();
        return Ok(());
    }
    let b = tauri::WebviewWindowBuilder::new(
        &app,
        "console",
        tauri::WebviewUrl::App("index.html?console=1".into()),
    )
    .title("Quelio — コンソール")
    .inner_size(980.0, 520.0)
    .min_inner_size(600.0, 300.0);
    #[cfg(target_os = "macos")]
    let b = b
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 26.0));
    b.build()
        .map_err(|e| format!("コンソールを開けません: {e}"))?;
    Ok(())
}

/// 任意のSQLを実行する
#[tauri::command]
pub async fn run_query(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    sql: String,
    offset: usize,
    order_by: Option<String>,
    order_dir: Option<String>,
    transaction: Option<bool>,
    explain: Option<String>,
) -> Result<RunOutput, String> {
    // SQL実行タイムアウトは設定画面の値を使う (0は無制限)
    let timeout_secs = crate::app_settings::load(&app)
        .map(|s| s.query_timeout_secs)
        .unwrap_or(crate::query::DEFAULT_QUERY_TIMEOUT_SECS);
    sessions::run_query(
        &state,
        &qlog,
        &session_id,
        database,
        &sql,
        offset,
        order_by,
        order_dir,
        transaction.unwrap_or(false),
        explain,
        timeout_secs,
    )
    .await
}

/// セッションを切断する (DB・SSHとも終了通知を送ってから閉じる)
#[tauri::command]
pub async fn disconnect_session(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
) -> Result<(), String> {
    sessions::disconnect(&state, &qlog, &session_id).await;
    Ok(())
}
