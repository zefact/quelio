//! 作業状態 (開いていたタブ・書きかけのSQL) の保存・復元。
//! 中身の形はフロントエンドが決めるので、ここではJSONをそのまま持つ

use serde_json::Value;
use tauri::AppHandle;

use crate::json_store;

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    json_store::config_path(app, "workspace.json")
}

/// 保存済みの作業状態を返す (無ければNone)。
///
/// 壊れて読めない場合はエラーを返す。「無し」として扱ってしまうと、
/// 画面側が空の状態で上書き保存し、書きかけのSQLを失うため
pub fn load(app: &AppHandle) -> Result<Option<Value>, String> {
    let path = store_path(app)?;
    json_store::read(&path, "作業状態")
}

/// この起動で一度でも保存したか (最初の1回だけ `.bak` を残すために見る)
static SAVED_ONCE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 作業状態を保存する (全上書き)。
///
/// この起動で最初の保存だけは `.bak` を残す。
/// 起動直後の内容を1つ残しておけば、タブを復元しない設定に切り替えた場合でも、
/// 前回の書きかけSQLを取り戻せる (毎回残すと、上書き後の内容で埋まってしまう)
pub fn save(app: &AppHandle, data: Value) -> Result<(), String> {
    let path = store_path(app)?;
    let text =
        serde_json::to_string(&data).map_err(|e| format!("作業状態のシリアライズに失敗: {e}"))?;
    let first = !SAVED_ONCE.swap(true, std::sync::atomic::Ordering::Relaxed);
    if first {
        json_store::write_with_backup(&path, &text, "作業状態")
    } else {
        json_store::write(&path, &text, "作業状態")
    }
}
