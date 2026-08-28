//! 接続先の管理と、接続そのもの。
//! 保存・削除・並べ替え・接続テスト・接続 / 切断

use super::*;

/// SSH踏み台のホスト鍵を信頼する (初回接続の確認ダイアログから呼ぶ)。
///
/// 記録した後は、次の接続から検証が効くようになる
#[tauri::command]
pub fn trust_ssh_host(host: String, port: u16, fingerprint: String) -> Result<(), String> {
    crate::known_hosts::trust(&host, port, &fingerprint)
}

/// 保存済みの接続先一式(フォルダ+接続)を返す
#[tauri::command]
pub fn list_connections(app: AppHandle) -> Result<ConnectionStore, String> {
    let mut store = storage::load(&app)?;
    // パスワードは画面に渡さない (接続処理はバックエンドで完結している)
    storage::mask_secrets(&mut store);
    Ok(store)
}

/// 接続プロファイルを保存(idが空なら新規採番)して保存後のものを返す
#[tauri::command]
pub fn save_connection(
    app: AppHandle,
    mut profile: ConnectionProfile,
) -> Result<ConnectionProfile, String> {
    // 画面が伏せたまま返してきた秘匿値は、保存済みの値で補う
    storage::restore_secrets(&app, &mut profile)?;
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
    // 保存したものを返すときも、パスワードは伏せる
    profile.password = String::new();
    profile.password_saved = !store
        .connections
        .iter()
        .find(|c| c.id == profile.id)
        .map(|c| c.password.is_empty())
        .unwrap_or(true);
    if let Some(ssh) = &mut profile.ssh {
        profile.passphrase_saved =
            ssh.passphrase.as_deref().is_some_and(|p| !p.is_empty());
        ssh.passphrase = None;
    }
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
    root_order: Option<Vec<String>>,
) -> Result<(), String> {
    let mut store = storage::load(&app)?;
    store.folders = folders;
    // ルート階層の表示順 (フォルダと接続の混在順)。未指定なら従来の順を維持する
    if let Some(root_order) = root_order {
        store.root_order = root_order;
    }

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

/// 設定フォルダのファイルが読める形かを1件ずつ確かめる
#[tauri::command]
pub fn check_config_files(
    app: AppHandle,
) -> Result<Vec<crate::json_store::ConfigFile>, String> {
    crate::json_store::check_all(&app)
}

/// 壊れた設定ファイルを退避して作り直せるようにし、退避先のパスを返す。
/// 読める状態のファイルは退避しない (誤って設定を消せないように)
#[tauri::command]
pub fn quarantine_config_file(app: AppHandle, name: String) -> Result<String, String> {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    crate::json_store::quarantine(&app, &name, &stamp)
}

/// 接続テスト(未保存のプロファイルでも実行可能)
#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    qlog: State<'_, QueryLog>,
    mut profile: ConnectionProfile,
) -> Result<TestResult, String> {
    // 画面が伏せたまま返してきた秘匿値は、保存済みの値で補う
    storage::restore_secrets(&app, &mut profile)?;
    /*
     * 鍵が読めずパスワードを復号できないのも「テストの失敗」の一種。
     * ここだけ Err で返していたため、画面では他の失敗が「接続失敗」、
     * これだけ「エラー」と別の見え方になっていた
     */
    if profile.password_locked {
        return Ok(TestResult {
            success: false,
            message: sessions::LOCKED_SECRET_MSG.to_string(),
            server_version: None,
            elapsed_ms: 0,
        });
    }
    Ok(db::run_test(profile, &qlog).await)
}

/// 接続を確立し、データベース一覧を返す (session_idはタブ単位の任意キー)
#[tauri::command]
pub async fn connect_session(
    state: State<'_, Sessions>,
    cancel: State<'_, CancelRegistry>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, CsvJobs>,
    session_id: String,
    mut profile: ConnectionProfile,
    app: AppHandle,
) -> Result<ConnectInfo, String> {
    // 画面が伏せたまま返してきた秘匿値は、保存済みの値で補う
    storage::restore_secrets(&app, &mut profile)?;
    sessions::connect(&state, &cancel, &qlog, &jobs, session_id, profile).await
}

/// セッションを切断する (DB・SSHとも終了通知を送ってから閉じる)
#[tauri::command]
pub async fn disconnect_session(
    state: State<'_, Sessions>,
    cancel: State<'_, CancelRegistry>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, CsvJobs>,
    session_id: String,
) -> Result<(), String> {
    sessions::disconnect(&state, &cancel, &qlog, &jobs, &session_id).await;
    Ok(())
}

/// 接続一覧をJSONファイルへ書き出す (件数を返す)
#[tauri::command]
pub fn export_connections(app: AppHandle, path: String) -> Result<usize, String> {
    crate::backup::export_connections(&app, &path)
}

/// JSONファイルから接続一覧を取り込む
#[tauri::command]
pub fn import_connections(
    app: AppHandle,
    path: String,
) -> Result<crate::backup::ImportResult, String> {
    crate::backup::import_connections(&app, &path)
}

/// SSH秘密鍵の参照ダイアログの初期フォルダを返す
/// (~/.ssh があればそこ、無ければホームディレクトリ)
#[tauri::command]
pub fn default_ssh_key_dir(app: AppHandle) -> Result<String, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("ホームディレクトリを取得できません: {e}"))?;
    let ssh = home.join(".ssh");
    let dir = if ssh.is_dir() { ssh } else { home };
    Ok(dir.to_string_lossy().to_string())
}
