//! アプリデータのエクスポート/インポート (接続一覧・ER図)。
//! 設定画面から呼ばれ、指定パスのJSONファイルと相互変換する。

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::er_store;
use crate::models::ConnectionStore;
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
        if let Some(ssh) = &mut c.ssh {
            ssh.passphrase = None;
        }
    }
    let text = serde_json::to_string_pretty(&store)
        .map_err(|e| format!("シリアライズに失敗: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("ファイルを書き込めません: {e}"))?;
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
