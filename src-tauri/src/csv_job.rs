//! CSV出力ジョブの進捗とキャンセルの管理。
//!
//! CSV出力は1回のコマンド呼び出しで完結するが、大量データでは時間がかかるため、
//! 別コマンドから進捗の取得とキャンセル要求ができるように状態を共有する

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// 1ジョブ分の状態
#[derive(Default)]
pub struct CsvJob {
    /// 書き出し済みの行数
    rows: AtomicUsize,
    /// キャンセルが要求されたか
    cancel: AtomicBool,
}

impl CsvJob {
    /// 書き出し済み行数を更新する
    pub fn set_rows(&self, rows: usize) {
        self.rows.store(rows, Ordering::Relaxed);
    }

    pub fn rows(&self) -> usize {
        self.rows.load(Ordering::Relaxed)
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/// 実行中のCSV出力ジョブ一覧 (Tauriのstateとして共有する)
#[derive(Default)]
pub struct CsvJobs(Mutex<HashMap<String, Arc<CsvJob>>>);

impl CsvJobs {
    /// ジョブを登録して状態を返す
    pub fn start(&self, id: &str) -> Arc<CsvJob> {
        let job = Arc::new(CsvJob::default());
        if let Ok(mut map) = self.0.lock() {
            map.insert(id.to_string(), job.clone());
        }
        job
    }

    /// 書き出し済み行数を返す (終了済み・未登録ならNone)
    pub fn rows(&self, id: &str) -> Option<usize> {
        self.0.lock().ok()?.get(id).map(|j| j.rows())
    }

    /// キャンセルを要求する
    pub fn cancel(&self, id: &str) {
        if let Ok(map) = self.0.lock() {
            if let Some(job) = map.get(id) {
                job.cancel.store(true, Ordering::Relaxed);
            }
        }
    }

    /// 終了したジョブを取り除く
    pub fn finish(&self, id: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(id);
        }
    }
}
