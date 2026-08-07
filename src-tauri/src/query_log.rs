//! DBに発行したSQLの履歴(コンソール表示用)

use std::sync::Mutex;

use serde::Serialize;

/// 保持する最大件数
const MAX_ENTRIES: usize = 2000;

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
}

impl QueryLog {
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
}
