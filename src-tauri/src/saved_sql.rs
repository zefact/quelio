//! 保存SQL (スニペット) の管理 (アプリ設定フォルダの saved_sql.json)

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSql {
    pub id: String,
    pub name: String,
    /// フォルダパス。空文字=ルート、階層は "/" 区切り (例: "集計/月次")
    #[serde(default)]
    pub folder: String,
    pub sql: String,
    pub updated_at_ms: u64,
}

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定ディレクトリを取得できません: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("設定ディレクトリを作成できません: {e}"))?;
    Ok(dir.join("saved_sql.json"))
}

pub fn load(app: &AppHandle) -> Result<Vec<SavedSql>, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("保存SQLを読み込めません: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("保存SQLの形式が不正です: {e}"))
}

fn save_all(app: &AppHandle, list: &[SavedSql]) -> Result<(), String> {
    let path = store_path(app)?;
    let text = serde_json::to_string_pretty(list)
        .map_err(|e| format!("保存SQLのシリアライズに失敗: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("保存SQLを書き込めません: {e}"))
}

/// フォルダパスを正規化する (前後空白と空セグメントを除去)
fn normalize_folder(folder: &str) -> String {
    folder
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 追加または更新して全件を返す (idが未指定なら新規採番)
pub fn upsert(
    app: &AppHandle,
    id: Option<String>,
    name: String,
    folder: String,
    sql: String,
) -> Result<Vec<SavedSql>, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("名前を入力してください".into());
    }
    if sql.trim().is_empty() {
        return Err("保存するSQLがありません".into());
    }
    let folder = normalize_folder(&folder);
    let mut list = load(app).unwrap_or_default();

    match id.filter(|s| !s.is_empty()) {
        Some(id) => {
            let entry = list
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or("保存SQLが見つかりません")?;
            entry.name = name;
            entry.folder = folder;
            entry.sql = sql;
            entry.updated_at_ms = now_ms();
        }
        None => {
            list.insert(
                0,
                SavedSql {
                    id: uuid::Uuid::new_v4().to_string(),
                    name,
                    folder,
                    sql,
                    updated_at_ms: now_ms(),
                },
            );
        }
    }
    save_all(app, &list)?;
    Ok(list)
}

/// 削除して全件を返す
pub fn delete(app: &AppHandle, id: &str) -> Result<Vec<SavedSql>, String> {
    let mut list = load(app).unwrap_or_default();
    list.retain(|e| e.id != id);
    save_all(app, &list)?;
    Ok(list)
}
