//! SQLパラメータ値の保存 (アプリ設定フォルダの sql_params.json)。
//! パラメータ名 → 直近に使った値と埋め込み方 を保持し、次回実行時の初期値に使う

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::json_store;

/// 保存する1パラメータぶんの情報
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ParamSaved {
    #[serde(default)]
    pub value: String,
    /// 埋め込み方 (auto / string / number / raw)
    #[serde(default = "default_kind")]
    pub kind: String,
}

fn default_kind() -> String {
    "auto".to_string()
}

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    json_store::config_path(app, "sql_params.json")
}

/// 保存形式。
/// 接続ごとに分けて持つ (開発DBで使った値が本番接続の初期値に出ないように)
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ParamStore {
    version: u32,
    /// 接続プロファイルID → (パラメータ名 → 保存値)
    by_connection: HashMap<String, HashMap<String, ParamSaved>>,
}

/// 現在の保存形式のバージョン。
/// 1 (接続で分けていない平坦な形) は読み捨てる
const VERSION: u32 = 2;

fn load_store(app: &AppHandle) -> Result<ParamStore, String> {
    let path = store_path(app)?;
    // 旧形式は読めなくて当然なので、読めなければ「無し」として扱う
    // (ここでエラーにすると、以後の保存まで一切できなくなる)
    let store: ParamStore = json_store::read(&path, "パラメータ")
        .ok()
        .flatten()
        .unwrap_or_default();
    if store.version != VERSION {
        return Ok(ParamStore {
            version: VERSION,
            by_connection: HashMap::new(),
        });
    }
    Ok(store)
}

/// 指定した接続で保存済みのパラメータ値を返す
pub fn load(app: &AppHandle, scope: &str) -> Result<HashMap<String, ParamSaved>, String> {
    Ok(load_store(app)?
        .by_connection
        .remove(scope)
        .unwrap_or_default())
}

/// パラメータ値を保存する (同じ接続の同名は上書き、その他は保持)
pub fn merge(
    app: &AppHandle,
    scope: &str,
    entries: HashMap<String, ParamSaved>,
) -> Result<(), String> {
    let mut store = load_store(app)?;
    store.version = VERSION;
    store
        .by_connection
        .entry(scope.to_string())
        .or_default()
        .extend(entries);
    let path = store_path(app)?;
    let text = serde_json::to_string(&store)
        .map_err(|e| format!("パラメータのシリアライズに失敗: {e}"))?;
    json_store::write(&path, &text, "パラメータ")
}
