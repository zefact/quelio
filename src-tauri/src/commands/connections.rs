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
    // 本番の接続はAIからの更新を許可できない (画面でも止めているが、ここでも見る)
    validate_ai_access(profile.env.as_deref(), profile.ai_access)?;
    // 画面が伏せたまま返してきた秘匿値は、保存済みの値で補う
    storage::restore_secrets(&app, &mut profile)?;
    let mut store = storage::load(&app)?;
    // 保存前の姿を控えておく (AIへ見える一覧が変わったかを見るため)
    let before = store
        .connections
        .iter()
        .find(|c| c.id == profile.id)
        .cloned();

    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
        store.connections.push(profile.clone());
    } else if let Some(slot) = store.connections.iter_mut().find(|c| c.id == profile.id) {
        *slot = profile.clone();
    } else {
        store.connections.push(profile.clone());
    }

    storage::save(&app, &store)?;
    // 公開のしかたが変わったなら、繋がっているAIクライアントへ知らせる
    if ai_list_changed(before.as_ref(), Some(&profile)) {
        notify_ai_list_changed(&app);
    }
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

/// 本番環境の接続に、AIからの更新を許可していないか確かめる。
///
/// 画面でも選べないようにしてあるが、保存の入口でも見る。
/// 片方だけの確認は、将来どちらかが外れたときに静かに穴になる
/// (実行時にも `mcp::session::effective_access` で見ている)
pub fn validate_ai_access(
    env: Option<&str>,
    access: crate::models::AiAccess,
) -> Result<(), String> {
    if env == Some("prod") && access == crate::models::AiAccess::Write {
        return Err("本番環境の接続はAIからの更新を許可できません".to_string());
    }
    Ok(())
}

/// AIへ見えている姿 (見えていなければ None)。
///
/// 公開レベルだけでなく名前も見る。名前はリソースのURIに入るので、
/// 変わったらクライアントが持っている一覧は古くなる
pub(crate) fn ai_visible(c: &ConnectionProfile) -> Option<AiView> {
    // Valkey は公開の対象外 (`mcp::session::find_by_name` と同じ判断)
    if !c.ai_access.is_exposed() || c.db_type == crate::models::DbType::Valkey {
        return None;
    }
    Some(AiView {
        name: c.name.clone(),
        access: c.ai_access,
        db_type: c.db_type,
        // SQLiteはファイルのパスではなく、URIに出る固定の名前で比べる
        database: if c.db_type == crate::models::DbType::Sqlite {
            crate::mcp::SQLITE_DB.to_string()
        } else {
            c.database.clone().unwrap_or_default().trim().to_string()
        },
    })
}

/// AIへ見えている姿。
///
/// これが変われば、クライアントが持っている一覧は古い。
/// 名前と公開レベルだけでなく、**既定データベースと種別**も入れる:
/// Resources の並びは `quelio://<接続名>/<DB名>/schema` の形で、
/// 既定DBを変えるとURIが変わり、外すと一覧から消えるため
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AiView {
    name: String,
    access: crate::models::AiAccess,
    db_type: crate::models::DbType,
    /// 既定データベース (無ければ空。SQLiteは `main` にそろえる)
    database: String,
}

/// AIへ見える一覧が変わったか
fn ai_list_changed(
    before: Option<&ConnectionProfile>,
    after: Option<&ConnectionProfile>,
) -> bool {
    before.and_then(ai_visible) != after.and_then(ai_visible)
}

/// AIへ見えている接続の一覧 (並びは問わないので名前順にそろえる)。
///
/// 1件ずつの比較ができない取り込み (`backup`) で、
/// 前後の姿を見比べるために使う
pub(crate) fn ai_visible_list(store: &ConnectionStore) -> Vec<AiView> {
    let mut list: Vec<AiView> = store.connections.iter().filter_map(ai_visible).collect();
    list.sort_by(|a, b| {
        (&a.name, a.access.as_str(), &a.database)
            .cmp(&(&b.name, b.access.as_str(), &b.database))
    });
    list
}

/// 繋がっているAIクライアントへ「一覧が変わった」と送る。
///
/// 送れなくても保存は成功させる (知らせるのは補助であり、
/// クライアントは次に一覧を取った時点で新しい姿を見る)
pub(crate) fn notify_ai_list_changed(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::mcp::notify_resources_changed(&app).await;
    });
}

/// 接続プロファイルを削除
#[tauri::command]
pub fn delete_connection(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = storage::load(&app)?;
    let before = store.connections.iter().find(|c| c.id == id).cloned();
    store.connections.retain(|c| c.id != id);
    storage::save(&app, &store)?;
    if ai_list_changed(before.as_ref(), None) {
        notify_ai_list_changed(&app);
    }
    Ok(())
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

/// SQLのお気に入りをJSONファイルへ書き出す (件数を返す)
#[tauri::command]
pub fn export_saved_sql(app: AppHandle, path: String) -> Result<usize, String> {
    crate::backup::export_saved_sql(&app, &path)
}

/// JSONファイルからSQLのお気に入りを取り込む
#[tauri::command]
pub fn import_saved_sql(
    app: AppHandle,
    path: String,
) -> Result<crate::backup::ImportResult, String> {
    crate::backup::import_saved_sql(&app, &path)
}

/// SQLのお気に入りのうち、選んだものだけをJSONファイルへ書き出す (件数を返す)。
/// お気に入りの画面のバックアップから呼ぶ
#[tauri::command]
pub fn export_saved_sql_subset(
    app: AppHandle,
    path: String,
    ids: Vec<String>,
    folders: Vec<String>,
) -> Result<usize, String> {
    crate::saved_sql::transfer::export_subset(&app, &path, &ids, &folders)
}

/// 取り込む前に、ファイルの中身の数を返す
#[tauri::command]
pub fn inspect_saved_sql_file(
    path: String,
) -> Result<crate::saved_sql::transfer::Summary, String> {
    crate::saved_sql::transfer::inspect_file(&path)
}

/// JSONファイルのお気に入りを、新しいフォルダを作ってその中へ取り込む。
/// 今あるお気に入りは変えない (お気に入りの画面の復元から呼ぶ)
#[tauri::command]
pub fn import_saved_sql_into(
    app: AppHandle,
    path: String,
    folder: String,
) -> Result<crate::saved_sql::transfer::ImportedInto, String> {
    crate::saved_sql::transfer::import_file_into(&app, &path, &folder)
}

/// 固定長のお気に入りをJSONファイルへ書き出す (件数を返す)
#[tauri::command]
pub fn export_csv_layouts(app: AppHandle, path: String) -> Result<usize, String> {
    crate::backup::export_csv_layouts(&app, &path)
}

/// JSONファイルから固定長のお気に入りを取り込む
#[tauri::command]
pub fn import_csv_layouts(
    app: AppHandle,
    path: String,
) -> Result<crate::backup::ImportResult, String> {
    crate::backup::import_csv_layouts(&app, &path)
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

/// お試し用のサンプルSQLite DBを用意して、そのファイルのパスを返す。
/// すでにあれば作り直さない
#[tauri::command]
pub async fn create_sample_database(app: AppHandle) -> Result<String, String> {
    crate::sample_db::ensure(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AiAccess;

    #[test]
    fn 本番の接続に更新は許可できない() {
        assert!(validate_ai_access(Some("prod"), AiAccess::Write).is_err());
    }

    #[test]
    fn 本番でも読み取りのみなら許可できる() {
        assert!(validate_ai_access(Some("prod"), AiAccess::Read).is_ok());
        assert!(validate_ai_access(Some("prod"), AiAccess::None).is_ok());
    }

    #[test]
    fn 本番以外は更新も許可できる() {
        for env in [Some("staging"), Some("dev"), None] {
            assert!(validate_ai_access(env, AiAccess::Write).is_ok(), "{env:?}");
        }
    }

    fn profile(name: &str, access: AiAccess) -> ConnectionProfile {
        ConnectionProfile {
            id: "1".to_string(),
            name: name.to_string(),
            db_type: crate::models::DbType::Mysql,
            host: "db.example.com".to_string(),
            port: 3306,
            user: "app".to_string(),
            password: String::new(),
            database: None,
            tls: false,
            ssl_mode: None,
            ca_cert_path: None,
            client_cert_path: None,
            client_key_path: None,
            read_only: false,
            ssh: None,
            proxy: None,
            folder_id: None,
            color: None,
            env: Some("dev".to_string()),
            ai_access: access,
            pinned: false,
            last_used_at: None,
            password_locked: false,
            password_saved: false,
            passphrase_saved: false,
        }
    }

    #[test]
    fn 公開をやめれば一覧は変わる() {
        let before = profile("開発DB", AiAccess::Read);
        let after = profile("開発DB", AiAccess::None);
        assert!(ai_list_changed(Some(&before), Some(&after)));
        assert!(ai_list_changed(Some(&after), Some(&before)));
    }

    #[test]
    fn 読み取りと更新の入れ替えも一覧は変わる() {
        let read = profile("開発DB", AiAccess::Read);
        let write = profile("開発DB", AiAccess::Write);
        assert!(ai_list_changed(Some(&read), Some(&write)));
    }

    #[test]
    fn 名前が変わればuriが変わるので一覧も変わる() {
        let before = profile("開発DB", AiAccess::Read);
        let after = profile("検証DB", AiAccess::Read);
        assert!(ai_list_changed(Some(&before), Some(&after)));
    }

    #[test]
    fn 公開していない接続の変更は知らせない() {
        let before = profile("開発DB", AiAccess::None);
        let after = profile("検証DB", AiAccess::None);
        assert!(!ai_list_changed(Some(&before), Some(&after)));
        // 消しても、見えていなかったのだから一覧は変わらない
        assert!(!ai_list_changed(Some(&before), None));
    }

    #[test]
    fn 公開中の接続を消せば一覧は変わる() {
        let before = profile("開発DB", AiAccess::Read);
        assert!(ai_list_changed(Some(&before), None));
    }

    #[test]
    fn 公開していても他の項目だけの変更では知らせない() {
        let mut before = profile("開発DB", AiAccess::Read);
        before.host = "a".to_string();
        let mut after = profile("開発DB", AiAccess::Read);
        after.host = "b".to_string();
        assert!(!ai_list_changed(Some(&before), Some(&after)));
    }

    #[test]
    fn 既定データベースを変えれば一覧は変わる() {
        // Resources のURIに入るので、変わると持っている一覧が古くなる
        let mut before = profile("開発DB", AiAccess::Read);
        before.database = Some("shop".to_string());
        let mut after = profile("開発DB", AiAccess::Read);
        after.database = Some("shop2".to_string());
        assert!(ai_list_changed(Some(&before), Some(&after)));

        // 既定DBを外すと一覧から消えるので、これも知らせる
        let mut cleared = profile("開発DB", AiAccess::Read);
        cleared.database = None;
        assert!(ai_list_changed(Some(&before), Some(&cleared)));

        // 同じなら知らせない
        let mut same = profile("開発DB", AiAccess::Read);
        same.database = Some("shop".to_string());
        assert!(!ai_list_changed(Some(&before), Some(&same)));
    }

    #[test]
    fn valkeyは公開対象外なので知らせない() {
        let mut before = profile("KV", AiAccess::Read);
        before.db_type = crate::models::DbType::Valkey;
        let mut after = profile("KV", AiAccess::Write);
        after.db_type = crate::models::DbType::Valkey;
        assert!(!ai_list_changed(Some(&before), Some(&after)));
    }
}
