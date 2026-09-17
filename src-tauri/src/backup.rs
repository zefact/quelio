//! アプリデータのエクスポート/インポート
//! (接続一覧・ER図・SQLのお気に入り・固定長のお気に入り)。
//! 設定画面から呼ばれ、指定パスのJSONファイルと相互変換する。

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::csv_layouts;
use crate::er_store;
use crate::models::ConnectionStore;
use crate::saved_sql;
use crate::storage;

/// インポート結果 (追加数・上書き数)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub added: usize,
    pub updated: usize,
}

/// 接続一覧をJSONファイルへ書き出す。
/// パスワード・SSHパスフレーズは秘匿情報のため含めない
pub fn export_connections(app: &AppHandle, path: &str) -> Result<usize, String> {
    let mut store = storage::load(app)?;
    for c in &mut store.connections {
        c.password = String::new();
        c.password_locked = false;
        // 「保存済み」の目印は書き出し先では意味がない
        c.password_saved = false;
        c.passphrase_saved = false;
        if let Some(ssh) = &mut c.ssh {
            ssh.passphrase = None;
        }
    }
    let text = serde_json::to_string_pretty(&store)
        .map_err(|e| format!("シリアライズに失敗: {e}"))?;
    // 接続先の一覧なので、所有者だけが読める権限で書き出す
    crate::outfile::write(path.as_ref(), text)
        .map_err(|e| format!("ファイルを書き込めません: {e}"))?;
    Ok(store.connections.len())
}

/// JSONファイルから接続一覧を取り込む。
/// idが一致する既存プロファイルは上書き (パスワード未設定なら既存を保持)、
/// それ以外は追加する
pub fn import_connections(app: &AppHandle, path: &str) -> Result<ImportResult, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    let incoming: ConnectionStore =
        serde_json::from_str(&text).map_err(|e| format!("接続一覧のJSON形式が不正です: {e}"))?;

    let mut store = storage::load(app)?;
    // 取り込みでAIへの公開が変わることがある (前後の姿を見比べる)
    let before = crate::commands::ai_visible_list(&store);
    let mut added = 0;
    let mut updated = 0;

    for f in incoming.folders {
        if let Some(existing) = store.folders.iter_mut().find(|x| x.id == f.id) {
            *existing = f;
        } else {
            store.folders.push(f);
        }
    }

    for mut c in incoming.connections {
        if c.id.is_empty() {
            c.id = uuid::Uuid::new_v4().to_string();
        }
        if let Some(existing) = store.connections.iter_mut().find(|x| x.id == c.id) {
            // エクスポートには秘匿情報が入っていないため、
            // 未設定のパスワード・パスフレーズは既存の値を引き継ぐ
            if c.password.is_empty() {
                c.password = existing.password.clone();
            }
            if let (Some(ssh_new), Some(ssh_old)) = (c.ssh.as_mut(), existing.ssh.as_ref()) {
                if ssh_new.passphrase.as_deref().unwrap_or("").is_empty() {
                    ssh_new.passphrase = ssh_old.passphrase.clone();
                }
            }
            *existing = c;
            updated += 1;
        } else {
            store.connections.push(c);
            added += 1;
        }
    }

    storage::save(app, &store)?;
    // 保存や削除と同じく、見える一覧が変わったらクライアントへ知らせる
    if crate::commands::ai_visible_list(&store) != before {
        crate::commands::notify_ai_list_changed(app);
    }
    Ok(ImportResult { added, updated })
}

/// 全ER図をJSONファイルへ書き出す
pub fn export_er_diagrams(app: &AppHandle, path: &str) -> Result<usize, String> {
    let all = er_store::all(app)?;
    let text =
        serde_json::to_string_pretty(&all).map_err(|e| format!("シリアライズに失敗: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("ファイルを書き込めません: {e}"))?;
    Ok(all.len())
}

/// JSONファイルからER図を取り込む (同名の図は上書き)
pub fn import_er_diagrams(app: &AppHandle, path: &str) -> Result<ImportResult, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    let incoming: HashMap<String, Value> =
        serde_json::from_str(&text).map_err(|e| format!("ER図のJSON形式が不正です: {e}"))?;
    let (added, updated) = er_store::merge(app, incoming)?;
    Ok(ImportResult { added, updated })
}

/// 保存SQL (お気に入り) をJSONファイルへ書き出す
pub fn export_saved_sql(app: &AppHandle, path: &str) -> Result<usize, String> {
    let store = saved_sql::load(app)?;
    let text =
        serde_json::to_string_pretty(&store).map_err(|e| format!("シリアライズに失敗: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("ファイルを書き込めません: {e}"))?;
    Ok(store.items.len())
}

/// JSONファイルから保存SQLを取り込む (同じIDのものは上書き)
pub fn import_saved_sql(app: &AppHandle, path: &str) -> Result<ImportResult, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    let incoming = saved_sql::parse(&text)?;
    let (added, updated) = saved_sql::merge(app, incoming)?;
    Ok(ImportResult { added, updated })
}

/// 固定長のお気に入りをJSONファイルへ書き出す (フォルダ分けごと)
pub fn export_csv_layouts(app: &AppHandle, path: &str) -> Result<usize, String> {
    let nodes = csv_layouts::tree(app)?;
    let text =
        serde_json::to_string_pretty(&nodes).map_err(|e| format!("シリアライズに失敗: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("ファイルを書き込めません: {e}"))?;
    Ok(csv_layouts::flatten(&nodes).len())
}

/// JSONファイルから固定長のお気に入りを取り込む (同じ名前のものは上書き)
pub fn import_csv_layouts(app: &AppHandle, path: &str) -> Result<ImportResult, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    let incoming = csv_layouts::parse(&text)?;
    let (added, updated) = csv_layouts::merge(app, incoming)?;
    Ok(ImportResult { added, updated })
}
