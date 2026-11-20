//! ER図の保存・読み込み (アプリ設定フォルダの er_diagrams.json)。
//! 中身 (スキーマ・配置・表示オプション) はフロントエンドが管理するJSONを
//! そのまま保持する。キーは自由な図の名前 (プロファイルをまたいで開ける)

use std::collections::HashMap;

use serde_json::Value;
use tauri::AppHandle;

use crate::json_store;

pub mod transfer;

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    json_store::config_path(app, "er_diagrams.json")
}

/// 読み込む。壊れていればエラー (空で上書きしてしまわないように)
fn load_all(app: &AppHandle) -> Result<HashMap<String, Value>, String> {
    let path = store_path(app)?;
    Ok(json_store::read(&path, "ER図")?.unwrap_or_default())
}

/// 指定キーの保存済みER図を返す (無ければNone)
pub fn load(app: &AppHandle, key: &str) -> Result<Option<Value>, String> {
    Ok(load_all(app)?.remove(key))
}

/// 指定キーでER図を保存する (上書き)
pub fn save(app: &AppHandle, key: String, data: Value) -> Result<(), String> {
    let mut all = load_all(app)?;
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
    let mut all = load_all(app)?;
    let (added, overwritten) = merge_into(&mut all, incoming);
    write_all(app, &all)?;
    Ok((added, overwritten.len()))
}

/**
 * 取り込んだら何件増えて、どれが上書きされるかを数える (書き込まない)。
 *
 * 判定は `merge` と同じ `merge_into` を、読んだ中身の写しに当てて求める。
 * 返すのは (追加数, 上書きされる図の名前 (名前順))
 */
pub fn preview_merge(
    app: &AppHandle,
    incoming: HashMap<String, Value>,
) -> Result<(usize, Vec<String>), String> {
    let mut all = load_all(app)?;
    Ok(merge_into(&mut all, incoming))
}

/// 今の図へ取り込む図を混ぜる (同名は上書き)。
/// (追加数, 上書きした図の名前 (名前順)) を返す
fn merge_into(
    all: &mut HashMap<String, Value>,
    incoming: HashMap<String, Value>,
) -> (usize, Vec<String>) {
    let mut added = 0;
    let mut overwritten = Vec::new();
    for (k, v) in incoming {
        if all.contains_key(&k) {
            overwritten.push(k.clone());
        } else {
            added += 1;
        }
        all.insert(k, v);
    }
    overwritten.sort();
    (added, overwritten)
}

/// 指定キーのER図を削除する
pub fn delete(app: &AppHandle, key: &str) -> Result<(), String> {
    let mut all = load_all(app)?;
    all.remove(key);
    write_all(app, &all)
}

fn write_all(app: &AppHandle, all: &HashMap<String, Value>) -> Result<(), String> {
    let path = store_path(app)?;
    let text =
        serde_json::to_string(all).map_err(|e| format!("ER図のシリアライズに失敗: {e}"))?;
    json_store::write(&path, &text, "ER図")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagrams(names: &[&str]) -> HashMap<String, Value> {
        names
            .iter()
            .map(|n| (n.to_string(), serde_json::json!({ "name": n })))
            .collect()
    }

    #[test]
    fn 同じ名前は上書きとして数える() {
        let mut all = diagrams(&["受注", "在庫"]);
        let (added, overwritten) = merge_into(&mut all, diagrams(&["在庫", "出荷", "受注"]));
        assert_eq!(added, 1);
        // 名前順で返す
        assert_eq!(overwritten, vec!["受注", "在庫"]);
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn 空へ取り込むとすべて追加になる() {
        let mut all = HashMap::new();
        let (added, overwritten) = merge_into(&mut all, diagrams(&["a", "b"]));
        assert_eq!(added, 2);
        assert!(overwritten.is_empty());
    }
}
