//! DBに発行したSQLの履歴(コンソール表示用)

use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 1件記録されたときに全ウィンドウへ流すイベント名
pub const QUERY_LOG_EVENT: &str = "query-log";

/// 保持する最大件数
const MAX_ENTRIES: usize = 2000;

/// 書き出す形式
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LogFormat {
    /// 表計算ソフトで開く用
    Csv,
    /// そのまま読む用
    Text,
}

/// 書き出した結果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedLog {
    /// 保存したファイルのフルパス
    pub path: String,
    /// 書き出した件数
    pub rows: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryLogEntry {
    /// 通し番号 (フロントの差分取得・key用)
    pub seq: u64,
    /// HH:MM:SS
    pub time: String,
    /// 接続名
    pub connection: String,
    /// データベース名
    pub database: String,
    /// 実行したSQL
    pub query: String,
}

#[derive(Default)]
pub struct QueryLog {
    inner: Mutex<(u64, Vec<QueryLogEntry>)>,
    /// 記録のたびに通知するためのハンドル (起動時に一度だけ入れる)
    app: OnceLock<AppHandle>,
}

impl QueryLog {
    /// 起動時に呼ぶ。以降、記録するたびにイベントを流す
    pub fn set_app(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    /// SQLを1件記録する
    pub fn add(&self, connection: &str, database: &str, query: &str) {
        let time = chrono::Local::now().format("%H:%M:%S").to_string();
        // SQL内の連続空白を1つにまとめて読みやすくする
        let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut guard = self.inner.lock().unwrap();
        let (seq, entries) = &mut *guard;
        *seq += 1;
        entries.push(QueryLogEntry {
            seq: *seq,
            time,
            connection: connection.to_string(),
            database: database.to_string(),
            query,
        });
        if entries.len() > MAX_ENTRIES {
            let overflow = entries.len() - MAX_ENTRIES;
            entries.drain(0..overflow);
        }
        let latest = entries.last().cloned();
        // 受け手側の処理でここへ戻ってきても固まらないよう、鍵を外してから通知する
        drop(guard);
        if let (Some(app), Some(entry)) = (self.app.get(), latest) {
            let _ = app.emit(QUERY_LOG_EVENT, entry);
        }
    }

    /// 指定seqより後のエントリを返す (afterSeq=0で全件)
    pub fn entries_after(&self, after_seq: u64) -> Vec<QueryLogEntry> {
        let guard = self.inner.lock().unwrap();
        guard
            .1
            .iter()
            .filter(|e| e.seq > after_seq)
            .cloned()
            .collect()
    }

    pub fn clear(&self) {
        self.inner.lock().unwrap().1.clear();
    }

    /// 記録を書き出す形に整える (絞り込みは画面と同じ見方をする)
    pub fn render(&self, filter: &str, format: LogFormat) -> (String, usize) {
        let entries = {
            let guard = self.inner.lock().unwrap();
            filtered(&guard.1, filter)
        };
        let text = match format {
            LogFormat::Csv => render_csv(&entries),
            LogFormat::Text => render_text(&entries),
        };
        (text, entries.len())
    }
}

/// 画面のフィルタと同じ見方で絞り込む (SQL / 接続名 / DB名の部分一致)。
///
/// 画面 (ConsoleWindow) は入力をそのまま小文字にして比べるだけなので、
/// ここでも前後の空白を落とさずに同じ見方をする
fn filtered(entries: &[QueryLogEntry], filter: &str) -> Vec<QueryLogEntry> {
    if filter.is_empty() {
        return entries.to_vec();
    }
    let f = filter.to_lowercase();
    entries
        .iter()
        .filter(|e| {
            e.query.to_lowercase().contains(&f)
                || e.connection.to_lowercase().contains(&f)
                || e.database.to_lowercase().contains(&f)
        })
        .cloned()
        .collect()
}

fn render_csv(entries: &[QueryLogEntry]) -> String {
    use crate::export::{csv_row_cells, CsvCell};
    let head = ["時刻", "接続", "データベース", "クエリ"]
        .iter()
        .map(|h| Some(CsvCell::text(h.to_string())))
        .collect::<Vec<_>>();
    // Excelで開いたときに見出しが化けないようBOMを付ける
    let mut out = "\u{FEFF}".to_string();
    out.push_str(&csv_row_cells(&head));
    for e in entries {
        out.push_str(&csv_row_cells(&[
            Some(CsvCell::text(e.time.clone())),
            Some(CsvCell::text(e.connection.clone())),
            Some(CsvCell::text(e.database.clone())),
            Some(CsvCell::text(e.query.clone())),
        ]));
    }
    out
}

fn render_text(entries: &[QueryLogEntry]) -> String {
    let mut out = String::new();
    for e in entries {
        // 接続とDBが分かる形で1行1件 (grepしやすさを優先する)
        out.push_str(&format!(
            "{}\t[{}/{}]\t{}\n",
            e.time, e.connection, e.database, e.query
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(seq: u64, connection: &str, database: &str, query: &str) -> QueryLogEntry {
        QueryLogEntry {
            seq,
            time: "12:00:00".to_string(),
            connection: connection.to_string(),
            database: database.to_string(),
            query: query.to_string(),
        }
    }

    #[test]
    fn 絞り込みは画面と同じ見方をする() {
        let list = vec![
            entry(1, "本番", "shop", "SELECT * FROM users"),
            entry(2, "検証", "test", "DELETE FROM logs"),
        ];
        // SQL・接続名・DB名のどれに当たっても残す (大小文字は区別しない)
        assert_eq!(filtered(&list, "select").len(), 1);
        assert_eq!(filtered(&list, "本番").len(), 1);
        assert_eq!(filtered(&list, "TEST").len(), 1);
        assert_eq!(filtered(&list, "").len(), 2);
        // 画面のフィルタは空白も文字として扱うので、ここでも同じにする
        assert_eq!(filtered(&list, "   ").len(), 0);
        assert_eq!(filtered(&list, "FROM users").len(), 1);
        assert_eq!(filtered(&list, "見つからない").len(), 0);
    }

    #[test]
    fn csvは数式として実行されない形にする() {
        let list = vec![entry(1, "本番", "shop", "=cmd|' /c calc'!A1")];
        let csv = render_csv(&list);
        assert!(csv.starts_with("\u{FEFF}\"時刻\",\"接続\",\"データベース\",\"クエリ\"\n"));
        // 先頭に ' が付いて、表計算ソフトが数式として読まない形になる
        assert!(csv.contains("\"'=cmd"), "{csv}");
    }

    #[test]
    fn テキストは1行1件で出す() {
        let list = vec![
            entry(1, "本番", "shop", "SELECT 1"),
            entry(2, "本番", "shop", "SELECT 2"),
        ];
        assert_eq!(
            render_text(&list),
            "12:00:00\t[本番/shop]\tSELECT 1\n12:00:00\t[本番/shop]\tSELECT 2\n"
        );
    }
}
