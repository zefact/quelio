//! 固定長のレイアウト (桁の並び) を名前を付けて残す。
//!
//! 固定長のファイルには桁の情報が入っていないので、同じ形式のファイルを
//! 開くたびに桁を入れ直すことになる。よく使う形はここへ残して選べるようにする
//! (アプリ設定フォルダの csv_layouts.json)

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::csv_doc::fixed::FixedLayout;
use crate::json_store;

/// 名前を付けて残した桁の並び
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedLayout {
    pub name: String,
    pub layout: FixedLayout,
    pub updated_at_ms: u64,
}

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    json_store::config_path(app, "csv_layouts.json")
}

/// 残してあるレイアウトを名前順で返す
pub fn load(app: &AppHandle) -> Result<Vec<SavedLayout>, String> {
    let path = store_path(app)?;
    let mut list: Vec<SavedLayout> =
        json_store::read(&path, "固定長のレイアウト")?.unwrap_or_default();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}

/// 名前を付けて残す (同じ名前があれば上書き)
pub fn save(app: &AppHandle, name: &str, layout: FixedLayout) -> Result<Vec<SavedLayout>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名前を入れてください".into());
    }
    if layout.columns.is_empty() {
        return Err("桁が1つもありません".into());
    }
    let mut list = load(app)?;
    let now = now_ms();
    match list.iter_mut().find(|s| s.name == name) {
        Some(found) => {
            found.layout = layout;
            found.updated_at_ms = now;
        }
        None => list.push(SavedLayout {
            name: name.to_string(),
            layout,
            updated_at_ms: now,
        }),
    }
    write(app, &list)?;
    Ok(list)
}

/// 名前を指定して消す
pub fn delete(app: &AppHandle, name: &str) -> Result<Vec<SavedLayout>, String> {
    let mut list = load(app)?;
    list.retain(|s| s.name != name);
    write(app, &list)?;
    Ok(list)
}

fn write(app: &AppHandle, list: &[SavedLayout]) -> Result<(), String> {
    let path = store_path(app)?;
    let text = serde_json::to_string_pretty(list)
        .map_err(|e| format!("固定長のレイアウトを組み立てられません: {e}"))?;
    json_store::write(&path, &text, "固定長のレイアウト")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
