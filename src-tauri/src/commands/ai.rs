//! AI連携 (MCPサーバー) の操作。
//!
//! 画面からは「入れる・切る」「ポートを変える」「トークンを作り直す」の3つ。
//! 設定そのものはアプリ設定 (`app_settings`) に持ち、
//! ここは保存のあとでサーバーを張り直す役をする

use tauri::AppHandle;

use crate::mcp;

/// AI連携の今の状態 (有効か・待ち受けているか・失敗の理由)
#[tauri::command]
pub async fn mcp_status(app: AppHandle) -> Result<mcp::McpStatus, String> {
    mcp::status(&app)
}

/// 設定に合わせて待受を張り直す。
///
/// 有効なら起動 (すでに動いていれば止めてから)、無効なら停止する
#[tauri::command]
pub async fn mcp_apply(app: AppHandle) -> Result<mcp::McpStatus, String> {
    // 起動に失敗しても状態は返す (画面に理由を出すため)
    let result = mcp::apply(&app).await;
    let status = mcp::status(&app)?;
    match result {
        Ok(()) => Ok(status),
        Err(_) => Ok(status),
    }
}

/// 発行済みのトークンを返す (無ければ作る)。
///
/// 画面では伏せ字にして出し、コピーだけできるようにする
#[tauri::command]
pub fn mcp_token(app: AppHandle) -> Result<String, String> {
    mcp::token(&app)
}

/// トークンを作り直す。
///
/// 古いトークンはこの瞬間から使えなくなるので、
/// 動いているサーバーも新しいトークンで張り直す
#[tauri::command]
pub async fn mcp_regenerate_token(app: AppHandle) -> Result<String, String> {
    let token = mcp::regenerate_token(&app)?;
    // 動いていたなら、新しいトークンで受け直す
    let _ = mcp::apply(&app).await;
    Ok(token)
}

/// AIクライアントの設定に書くエンドポイント
#[tauri::command]
pub fn mcp_endpoint(app: AppHandle) -> Result<String, String> {
    let settings = crate::app_settings::load(&app)?;
    Ok(mcp::endpoint(settings.mcp_port))
}

/// 待っている「更新の許可」の一覧。
///
/// 画面はイベントで受け取るが、開き直した直後などは取りこぼしうるので、
/// マウント時にここから取り直す
#[tauri::command]
pub fn mcp_pending_approvals(app: AppHandle) -> Vec<mcp::PendingView> {
    mcp::pending_approvals(&app)
}

/// 「更新の許可」に答える (許可 / 拒否)
#[tauri::command]
pub fn mcp_approval_respond(
    app: AppHandle,
    request_id: String,
    allow: bool,
) -> Result<(), String> {
    mcp::approval_respond(&app, &request_id, allow)
}

/// このアプリの実行ファイルの絶対パス。
///
/// Claude Desktop は「コマンドを起動して stdio で話す」形しか扱えないので、
/// 設定には Quelio 自身のパスを書いてもらう
/// (`--mcp-stdio` を付けて起動すると、中継役として動く)
#[tauri::command]
pub fn mcp_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .map_err(|e| format!("実行ファイルの場所を取得できません: {e}"))
}
