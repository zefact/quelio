//! 別ウィンドウ (スキーマ・ER図・差分・コンソール) と、
//! アプリ全体の設定・作業状態・ログ

use super::*;

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

/// 既に開いているウィンドウを、指定のURL (接続・DBが入っている) に合わせる。
///
/// 同じURLなら何もしない。開き直しの指示ではないときに読み込み直すと、
/// 編集中のER図などを捨ててしまうため
fn reload_if_needed(w: &tauri::WebviewWindow, url: &str) {
    let Ok(current) = w.url() else {
        return;
    };
    let Ok(next) = current.join(url) else {
        return;
    };
    if next != current {
        let _ = w.navigate(next);
    }
}

/// スキーマ一覧ウィンドウを開く(既にあればフォーカス)
#[tauri::command]
pub async fn open_schema(
    app: AppHandle,
    session_id: String,
    database: String,
) -> Result<(), String> {
    let url = format!(
        "index.html?schema=1&session={}&db={}",
        url_encode(&session_id),
        url_encode(&database)
    );
    if let Some(w) = app.get_webview_window("schema") {
        // 別の接続・DBから開き直したときは、その内容に差し替える
        // (フォーカスするだけだと、前に開いたDBのまま見えてしまう)
        reload_if_needed(&w, &url);
        let _ = w.set_focus();
        return Ok(());
    }
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

/// ER図ウィンドウを開く(既にあればフォーカス)
#[tauri::command]
pub async fn open_er(
    app: AppHandle,
    session_id: String,
    database: String,
) -> Result<(), String> {
    let url = format!(
        "index.html?er=1&session={}&db={}",
        url_encode(&session_id),
        url_encode(&database)
    );
    if let Some(w) = app.get_webview_window("er") {
        // 別の接続・DBから開き直したときは、その内容に差し替える
        reload_if_needed(&w, &url);
        let _ = w.set_focus();
        return Ok(());
    }
    let b = tauri::WebviewWindowBuilder::new(&app, "er", tauri::WebviewUrl::App(url.into()))
        .title("Quelio — ER図")
        .inner_size(1300.0, 820.0)
        .min_inner_size(800.0, 480.0);
    #[cfg(target_os = "macos")]
    let b = b
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 26.0));
    b.build().map_err(|e| format!("ER図を開けません: {e}"))?;
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

/// 前回の作業状態 (タブ・書きかけSQL) を返す (無ければnull)
#[tauri::command]
pub fn get_workspace(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    crate::workspace::load(&app)
}

/// 作業状態を保存する (全上書き)
#[tauri::command]
pub fn save_workspace(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    crate::workspace::save(&app, data)
}

/// 保存済みER図を返す (無ければnull)
#[tauri::command]
pub fn get_er_diagram(
    app: AppHandle,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    crate::er_store::load(&app, &key)
}

/// ER図を保存する (キーごとに上書き)
#[tauri::command]
pub fn save_er_diagram(
    app: AppHandle,
    key: String,
    data: serde_json::Value,
) -> Result<(), String> {
    crate::er_store::save(&app, key, data)
}

/// 保存済みER図のキー一覧を返す
#[tauri::command]
pub fn list_er_diagrams(app: AppHandle) -> Result<Vec<String>, String> {
    crate::er_store::list(&app)
}

/// 保存済みER図を削除する
#[tauri::command]
pub fn delete_er_diagram(app: AppHandle, key: String) -> Result<(), String> {
    crate::er_store::delete(&app, &key)
}

/// 全ER図をJSONファイルへ書き出す (件数を返す)
#[tauri::command]
pub fn export_er_diagrams(app: AppHandle, path: String) -> Result<usize, String> {
    crate::backup::export_er_diagrams(&app, &path)
}

/// JSONファイルからER図を取り込む
#[tauri::command]
pub fn import_er_diagrams(
    app: AppHandle,
    path: String,
) -> Result<crate::backup::ImportResult, String> {
    crate::backup::import_er_diagrams(&app, &path)
}

/// クエリログを返す (after_seqより新しいもの。0で全件)
#[tauri::command]
pub fn get_query_log(
    qlog: State<'_, QueryLog>,
    after_seq: u64,
) -> Result<Vec<QueryLogEntry>, String> {
    Ok(qlog.entries_after(after_seq))
}

/// クエリログをファイルへ書き出す (保存先のパスを返す)
#[tauri::command]
pub fn export_query_log(
    app: AppHandle,
    qlog: State<'_, QueryLog>,
    filter: String,
    format: crate::query_log::LogFormat,
) -> Result<crate::query_log::ExportedLog, String> {
    let (text, rows) = qlog.render(&filter, format);
    if rows == 0 {
        return Err("書き出す記録がありません".to_string());
    }
    // 設定の「保存先フォルダ」に従う (未設定ならOSのダウンロードフォルダ)
    let dir = crate::app_settings::download_dir(&app)?;
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let ext = match format {
        crate::query_log::LogFormat::Csv => "csv",
        crate::query_log::LogFormat::Text => "txt",
    };
    // 同じ秒に2回押しても前のファイルを消さない
    let path = crate::filename::unique_path(&dir, &format!("quelio_sqllog_{ts}"), ext)?;
    crate::outfile::write(&path, text).map_err(|e| format!("ファイルを書き込めません: {e}"))?;
    Ok(crate::query_log::ExportedLog {
        path: path.to_string_lossy().to_string(),
        rows,
    })
}

/// クエリログを消去する
#[tauri::command]
pub fn clear_query_log(qlog: State<'_, QueryLog>) -> Result<(), String> {
    qlog.clear();
    Ok(())
}

/// 保存したファイルの場所をOSのファイラで開く (フォルダを開いて選択状態にする)
#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("フォルダを開けません: {e}"))
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
    // 設定の「保存先フォルダ」に従う (未設定ならOSのダウンロードフォルダ)
    let dir = crate::app_settings::download_dir(&app)?;
    // パス区切り等を除去した安全なファイル名にする (拡張子は残す)
    let path = dir.join(crate::filename::safe_file_name(&file_name));
    crate::outfile::write(&path, bytes).map_err(|e| format!("画像を書き込めません: {e}"))?;
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
