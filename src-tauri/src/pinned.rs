//! よく見るテーブルのピン留め (アプリ設定フォルダの pinned_tables.json)。
//!
//! テーブルが数百あるDBでは、一覧から目的のものを探すだけで手間がかかる。
//! 接続プロファイルとデータベースの組ごとに、よく開くテーブルを覚えておき、
//! 一覧の先頭にまとめて出せるようにする

use std::collections::HashMap;

use tauri::AppHandle;

use crate::json_store;

/// キーの区切り (テーブル名にも接続IDにも出てこない制御文字を使う)
const SEP: char = '\u{1f}';

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    json_store::config_path(app, "pinned_tables.json")
}

/// 接続とデータベースの組をひとつのキーにする
pub fn group_key(profile_id: &str, database: &str) -> String {
    format!("{profile_id}{SEP}{database}")
}

/// ピンを付け外しする。並びは名前順で、同じものは1つだけ残す
pub fn toggle(list: &mut Vec<String>, table: &str, pinned: bool) {
    list.retain(|t| t != table);
    if pinned {
        list.push(table.to_string());
    }
    list.sort();
    list.dedup();
}

/// 読み込む。壊れていればエラー (空で上書きしてしまわないように)
fn load_all(app: &AppHandle) -> Result<HashMap<String, Vec<String>>, String> {
    let path = store_path(app)?;
    Ok(json_store::read(&path, "ピン留め")?.unwrap_or_default())
}

/// 指定の接続・DBでピン留めしているテーブルを返す (名前順)
pub fn list(app: &AppHandle, profile_id: &str, database: &str) -> Result<Vec<String>, String> {
    Ok(load_all(app)?
        .remove(&group_key(profile_id, database))
        .unwrap_or_default())
}

/// ピンを付け外しして、そのあとの一覧を返す
pub fn set(
    app: &AppHandle,
    profile_id: &str,
    database: &str,
    table: &str,
    pinned: bool,
) -> Result<Vec<String>, String> {
    let mut all = load_all(app)?;
    let key = group_key(profile_id, database);
    let entry = all.entry(key.clone()).or_default();
    toggle(entry, table, pinned);
    let after = entry.clone();
    // 空になった組は残さない (使わない接続のゴミを溜めない)
    if after.is_empty() {
        all.remove(&key);
    }
    write_all(app, &all)?;
    Ok(after)
}

fn write_all(app: &AppHandle, all: &HashMap<String, Vec<String>>) -> Result<(), String> {
    let path = store_path(app)?;
    let text = serde_json::to_string(all)
        .map_err(|e| format!("ピン留めのシリアライズに失敗: {e}"))?;
    json_store::write(&path, &text, "ピン留め")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 接続とdbでキーが分かれる() {
        assert_ne!(group_key("p1", "app"), group_key("p1", "app2"));
        assert_ne!(group_key("p1", "app"), group_key("p2", "app"));
        assert_eq!(group_key("p1", "app"), group_key("p1", "app"));
    }

    #[test]
    fn 付けると名前順に並ぶ() {
        let mut list = vec![];
        toggle(&mut list, "m_users", true);
        toggle(&mut list, "m_shops", true);
        toggle(&mut list, "t_orders", true);
        assert_eq!(list, vec!["m_shops", "m_users", "t_orders"]);
    }

    #[test]
    fn 同じものを二重に付けない() {
        let mut list = vec![];
        toggle(&mut list, "m_users", true);
        toggle(&mut list, "m_users", true);
        assert_eq!(list, vec!["m_users"]);
    }

    #[test]
    fn 外すと消える() {
        let mut list = vec!["m_users".to_string(), "t_orders".to_string()];
        toggle(&mut list, "m_users", false);
        assert_eq!(list, vec!["t_orders"]);
    }

    #[test]
    fn 無いものを外しても壊れない() {
        let mut list = vec!["m_users".to_string()];
        toggle(&mut list, "t_orders", false);
        assert_eq!(list, vec!["m_users"]);
    }
}
