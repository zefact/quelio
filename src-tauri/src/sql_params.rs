//! SQLパラメータ値の保存 (アプリ設定フォルダの sql_params.json)。
//! パラメータ名 → 直近に使った値と埋め込み方 を保持し、次回実行時の初期値に使う

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定ディレクトリを取得できません: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("設定ディレクトリを作成できません: {e}"))?;
    Ok(dir.join("sql_params.json"))
}

/// 保存済みのパラメータ値を全て返す。
/// 旧形式 (名前 → 値の文字列のみ) は kind=auto として読み込む
pub fn load(app: &AppHandle) -> Result<HashMap<String, ParamSaved>, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("パラメータを読み込めません: {e}"))?;
    let raw: HashMap<String, serde_json::Value> =
        serde_json::from_str(&text).map_err(|e| format!("パラメータの形式が不正です: {e}"))?;
    let mut out = HashMap::new();
    for (name, v) in raw {
        let entry = match v {
            serde_json::Value::String(s) => ParamSaved {
                value: s,
                kind: default_kind(),
            },
            other => serde_json::from_value(other)
                .unwrap_or_else(|_| ParamSaved {
                    value: String::new(),
                    kind: default_kind(),
                }),
        };
        out.insert(name, entry);
    }
    Ok(out)
}

/// パラメータ値を保存する (同名は上書き、その他は保持)
pub fn merge(app: &AppHandle, entries: HashMap<String, ParamSaved>) -> Result<(), String> {
    let mut all = load(app).unwrap_or_default();
    all.extend(entries);
    let path = store_path(app)?;
    let text = serde_json::to_string(&all)
        .map_err(|e| format!("パラメータのシリアライズに失敗: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("パラメータを書き込めません: {e}"))
}
