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

/// 履歴を新しい順で読み込む (ファイルが無ければ空)。
///
/// パスワードを伏せる前の版で残った履歴は、ここで伏せて書き直す
/// (ファイルに平文のまま残し続けないように)
pub fn load(app: &AppHandle) -> Result<Vec<HistoryEntry>, String> {
    let path = history_path(app)?;
    let mut list: Vec<HistoryEntry> = json_store::read(&path, "履歴")?.unwrap_or_default();
    if scrub_saved(&mut list) {
        save_all(app, &list)?;
    }
    Ok(list)
}

/// 保存済みの履歴のSQLからパスワードを伏せる。書き換えたものがあれば true。
///
/// 以前の版はSQLかValkeyのコマンドかを残していないので、SQLとして伏せる
/// (Valkeyのコマンドを行ごとに伏せると、`auth = 1` のようなSQLの行まで書き換えてしまう)。
/// 伏せた結果、同じ本文が2件になったら新しい方を残す
fn scrub_saved(list: &mut Vec<HistoryEntry>) -> bool {
    let mut changed = false;
    for e in list.iter_mut() {
        let masked = crate::sql_secret::mask(&e.sql);
        if masked != e.sql {
            e.sql = masked;
            changed = true;
        }
    }
    if changed {
        let mut seen = std::collections::HashSet::new();
        list.retain(|e| seen.insert(e.sql.clone()));
    }
    changed
}

/// 履歴に残す形に直す (パスワードを伏せる)。
///
/// SQLは `CREATE USER … IDENTIFIED BY '…'` などのパスワード、
/// Valkeyは `AUTH` / `CONFIG SET requirepass` などの値を伏せる
pub fn masked(sql: &str, valkey: bool) -> String {
    if valkey {
        sql.lines()
            .map(crate::kv::mask_secrets)
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        crate::sql_secret::mask(sql)
    }
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
/// 同じSQLが既にあれば先頭へ移動し、最大件数を超えた分は古い順に捨てる。
/// パスワードは伏せてから残す (`valkey` はValkeyのコマンドか)
pub fn add(app: &AppHandle, sql: String, valkey: bool) -> Result<(), String> {
    let sql = masked(sql.trim(), valkey);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(sql: &str, at: u64) -> HistoryEntry {
        HistoryEntry {
            sql: sql.to_string(),
            executed_at_ms: at,
        }
    }

    #[test]
    fn 残すときにsqlのパスワードを伏せる() {
        let out = masked("SELECT 1;\nCREATE USER 'u'@'%' IDENTIFIED BY 'ひみつ'", false);
        assert_eq!(out, "SELECT 1;\nCREATE USER 'u'@'%' IDENTIFIED BY '********'");
    }

    #[test]
    fn 残すときにvalkeyのパスワードを伏せる() {
        let out = masked("SET a 1\nAUTH alice hunter2\nGET a", true);
        assert_eq!(out, "SET a 1\nAUTH alice (値は伏せています)\nGET a");
        // SQLとして残すときは、行の頭の auth を書き換えない
        let sql = "SELECT id,\nauth = 1 AS ok\nFROM t";
        assert_eq!(masked(sql, false), sql);
    }

    #[test]
    fn 保存済みの履歴も伏せて重複をまとめる() {
        let mut list = vec![
            entry("CREATE USER 'u'@'%' IDENTIFIED BY 'new'", 3),
            entry("SELECT 1", 2),
            entry("CREATE USER 'u'@'%' IDENTIFIED BY 'old'", 1),
        ];
        assert!(scrub_saved(&mut list));
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].sql, "CREATE USER 'u'@'%' IDENTIFIED BY '********'");
        assert_eq!(list[0].executed_at_ms, 3, "新しい方を残す");
        assert_eq!(list[1].sql, "SELECT 1");
        // 伏せるものが無ければ書き直さない
        assert!(!scrub_saved(&mut list));
    }
}
