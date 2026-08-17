//! ER図の保存・読み込み (アプリ設定フォルダの er_diagrams.json)。
//! 中身 (スキーマ・配置・表示オプション) はフロントエンドが管理するJSONを
//! そのまま保持する。キーは自由な図の名前 (プロファイルをまたいで開ける)

use std::collections::HashMap;

use serde_json::Value;
use tauri::{AppHandle, Manager};

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定ディレクトリを取得できません: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("設定ディレクトリを作成できません: {e}"))?;
    Ok(dir.join("er_diagrams.json"))
}

fn load_all(app: &AppHandle) -> Result<HashMap<String, Value>, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("ER図を読み込めません: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("ER図の形式が不正です: {e}"))
}

/// 指定キーの保存済みER図を返す (無ければNone)
pub fn load(app: &AppHandle, key: &str) -> Result<Option<Value>, String> {
    Ok(load_all(app)?.remove(key))
}

/// 指定キーでER図を保存する (上書き)
pub fn save(app: &AppHandle, key: String, data: Value) -> Result<(), String> {
    let mut all = load_all(app).unwrap_or_default();
    all.insert(key, data);
    write_all(app, &all)
}

/// 保存済みER図のキー一覧を返す (名前順)
pub fn list(app: &AppHandle) -> Result<Vec<String>, String> {
    let mut keys: Vec<String> = load_all(app)?.into_keys().collect();
    keys.sort();
    Ok(keys)
}

/// 全ER図を返す (エクスポート用)
pub fn all(app: &AppHandle) -> Result<HashMap<String, Value>, String> {
    load_all(app)
}

/// 複数のER図を取り込む (同名は上書き)。(追加数, 上書き数) を返す
pub fn merge(
    app: &AppHandle,
    incoming: HashMap<String, Value>,
) -> Result<(usize, usize), String> {
    let mut all = load_all(app).unwrap_or_default();
    let mut added = 0;
    let mut updated = 0;
    for (k, v) in incoming {
        if all.insert(k, v).is_some() {
            updated += 1;
        } else {
            added += 1;
        }
    }
    write_all(app, &all)?;
    Ok((added, updated))
}

/// 指定キーのER図を削除する
pub fn delete(app: &AppHandle, key: &str) -> Result<(), String> {
    let mut all = load_all(app).unwrap_or_default();
    all.remove(key);
    write_all(app, &all)
}

fn write_all(app: &AppHandle, all: &HashMap<String, Value>) -> Result<(), String> {
    let path = store_path(app)?;
    let text =
        serde_json::to_string(all).map_err(|e| format!("ER図のシリアライズに失敗: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("ER図を書き込めません: {e}"))
}
