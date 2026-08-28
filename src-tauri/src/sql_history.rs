//! SQL実行履歴の保存・読み込み (アプリ設定フォルダの sql_history.json)

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::json_store;

/// 保持する履歴の最大件数
const MAX_HISTORY: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub sql: String,
    /// 実行日時 (UNIXエポックms)
    pub executed_at_ms: u64,
}

fn history_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    json_store::config_path(app, "sql_history.json")
}

/// 履歴を新しい順で読み込む (ファイルが無ければ空)
pub fn load(app: &AppHandle) -> Result<Vec<HistoryEntry>, String> {
    let path = history_path(app)?;
    Ok(json_store::read(&path, "履歴")?.unwrap_or_default())
}

/// 書き出し (件数の上限は呼ぶ側で守る)
fn save_all(app: &AppHandle, list: &[HistoryEntry]) -> Result<(), String> {
    let path = history_path(app)?;
    let text = serde_json::to_string_pretty(list)
        .map_err(|e| format!("履歴のシリアライズに失敗: {e}"))?;
    json_store::write(&path, &text, "履歴")
}

/// 1件だけ消して、残りを新しい順で返す。
///
/// 同じ本文の履歴は1件しか持たない (追加時に前のものを消す) ので、
/// 本文で指せば取り違えは起きない
pub fn remove(app: &AppHandle, sql: &str) -> Result<Vec<HistoryEntry>, String> {
    let mut list = load(app)?;
    list.retain(|e| e.sql != sql);
    save_all(app, &list)?;
    Ok(list)
}

/// すべて消す
pub fn clear(app: &AppHandle) -> Result<Vec<HistoryEntry>, String> {
    save_all(app, &[])?;
    Ok(Vec::new())
}

/// 履歴の先頭に追加する。
/// 同じSQLが既にあれば先頭へ移動し、最大件数を超えた分は古い順に捨てる
pub fn add(app: &AppHandle, sql: String) -> Result<(), String> {
    let sql = sql.trim().to_string();
    if sql.is_empty() {
        return Ok(());
    }
    let mut list = load(app)?;
    list.retain(|e| e.sql != sql);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    list.insert(
        0,
        HistoryEntry {
            sql,
            executed_at_ms: now,
        },
    );
    list.truncate(MAX_HISTORY);
    save_all(app, &list)
}
