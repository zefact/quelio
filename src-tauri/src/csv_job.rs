//! 行数で進む処理の進捗とキャンセルの管理。
//!
//! CSVの出力・取り込み、Valkeyのキー一括削除・値検索で使う。
//! どれも1回のコマンド呼び出しで完結するが、件数が多いと時間がかかるため、
//! 別コマンドから進捗の取得とキャンセル要求ができるように状態を共有する

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// 処理の局面。
///
/// 件数だけを見せていると、`COMMIT` や `ROLLBACK` の間は数字が止まったまま
/// 「取り込み中」と出続けてしまう。MySQL (InnoDB) の巻き戻しは
/// undoログを1行ずつ逆再生する処理で、取り込み本体より時間がかかることがあり、
/// 「中止を押したのに固まった」と誤解されてアプリごと落とされてしまう
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobPhase {
    /// 本体の処理中 (画面に出す言葉は呼び出し側が決める)
    Working,
    /// 確定中 (COMMIT)
    Committing,
    /// 取り消し中 (ROLLBACK)
    RollingBack,
}

impl JobPhase {
    fn code(self) -> u8 {
        match self {
            JobPhase::Working => 0,
            JobPhase::Committing => 1,
            JobPhase::RollingBack => 2,
        }
    }

    fn from_code(v: u8) -> JobPhase {
        match v {
            1 => JobPhase::Committing,
            2 => JobPhase::RollingBack,
            _ => JobPhase::Working,
        }
    }
}

/// 画面へ返す進捗
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    /// ここまでに処理した件数
    pub rows: usize,
    pub phase: JobPhase,
}

/// 1ジョブ分の状態
#[derive(Default)]
pub struct CsvJob {
    /// ここまでに処理した件数
    rows: AtomicUsize,
    /// 今どの局面か (`JobPhase` を数値で持つ)
    phase: AtomicU8,
    /// キャンセルが要求されたか
    cancel: AtomicBool,
    /// 接続を握って実際に動き始めたか。
    /// 動き出す前にサーバーへ中止を送ると、
    /// その接続でたまたま走っている別のSQLを止めてしまう
    running: AtomicBool,
}

impl CsvJob {
    /// 処理した件数を更新する
    pub fn set_rows(&self, rows: usize) {
        self.rows.store(rows, Ordering::Relaxed);
    }

    pub fn rows(&self) -> usize {
        self.rows.load(Ordering::Relaxed)
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// 接続を握ったことを記録する (ここから先はサーバーへ中止を送ってよい)
    pub fn mark_running(&self) {
        self.running.store(true, Ordering::Relaxed);
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    /// 局面を切り替える (確定・取り消しに入るときに呼ぶ)
    pub fn set_phase(&self, phase: JobPhase) {
        self.phase.store(phase.code(), Ordering::Relaxed);
    }

    pub fn phase(&self) -> JobPhase {
        JobPhase::from_code(self.phase.load(Ordering::Relaxed))
    }

    fn progress(&self) -> JobProgress {
        JobProgress {
            rows: self.rows(),
            phase: self.phase(),
        }
    }
}

/// 登録中のジョブ1件 (どのセッションのものかを覚えておく)
struct Entry {
    /// このジョブを動かしているセッションID。
    /// 切断されたときに、そのセッションのジョブだけを止めるために持つ
    session_id: String,
    job: Arc<CsvJob>,
}

/// 実行中のジョブ一覧 (Tauriのstateとして共有する)
#[derive(Default)]
pub struct CsvJobs(Mutex<HashMap<String, Entry>>);

impl CsvJobs {
    /*
     * ロックの中では即値を触るだけで待たない (awaitも挟まない) ので、
     * 途中でパニックして毒 (poison) になることは無い。
     * それでも毒を握り潰すと「中止が効かなくなったことに誰も気づけない」ため、
     * 中身をそのまま取り出して使い続ける
     */
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// ジョブを登録して状態を返す
    pub fn start(&self, id: &str, session_id: &str) -> Arc<CsvJob> {
        let job = Arc::new(CsvJob::default());
        self.map().insert(
            id.to_string(),
            Entry {
                session_id: session_id.to_string(),
                job: job.clone(),
            },
        );
        job
    }

    /// 進捗を返す (開始前・終了済み・未登録ならNone)
    pub fn progress(&self, id: &str) -> Option<JobProgress> {
        self.map().get(id).map(|e| e.job.progress())
    }

    /// 処理した件数を返す (テストと内部用)
    #[cfg(test)]
    fn rows(&self, id: &str) -> Option<usize> {
        self.map().get(id).map(|e| e.job.rows())
    }

    /// キャンセルを要求する。
    /// 「今回はじめて要求した」ときだけ true を返す (連打で何度も送らないため)
    pub fn cancel(&self, id: &str) -> bool {
        match self.map().get(id) {
            Some(e) => !e.job.cancel.swap(true, Ordering::Relaxed),
            None => false,
        }
    }

    /// あるセッションのジョブをすべてキャンセルする (切断時に使う)。
    ///
    /// ジョブは自分でバッチの切れ目にこの印を見るので、
    /// サーバーへのKILLが効かないSQLiteでも確実に止まる
    pub fn cancel_session(&self, session_id: &str) {
        for e in self.map().values().filter(|e| e.session_id == session_id) {
            e.job.cancel.store(true, Ordering::Relaxed);
        }
    }

    /// サーバー側にも中止を送るべきジョブなら、そのセッションIDを返す。
    ///
    /// まだ接続を握っていないジョブに対して送ると、
    /// その接続で走っている無関係なSQLを止めてしまうので、動き出す前は None
    pub fn running_session_of(&self, id: &str) -> Option<String> {
        self.map()
            .get(id)
            .filter(|e| e.job.is_running())
            .map(|e| e.session_id.clone())
    }

    /// 終了したジョブを取り除く。
    ///
    /// 万一IDが重なっても他人の登録を消さないよう、
    /// 自分が始めたジョブと同じものだけを取り除く
    pub fn finish(&self, id: &str, job: &Arc<CsvJob>) {
        let mut map = self.map();
        if map.get(id).is_some_and(|e| Arc::ptr_eq(&e.job, job)) {
            map.remove(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 切断したセッションのジョブだけ止める() {
        let jobs = CsvJobs::default();
        let a = jobs.start("j1", "s1");
        let b = jobs.start("j2", "s1");
        let other = jobs.start("j3", "s2");

        jobs.cancel_session("s1");
        assert!(a.is_cancelled());
        assert!(b.is_cancelled());
        // 別のタブで動いているものは巻き添えにしない
        assert!(!other.is_cancelled());
    }

    #[test]
    fn 終了したジョブは対象にならない() {
        let jobs = CsvJobs::default();
        let a = jobs.start("j1", "s1");
        jobs.finish("j1", &a);
        jobs.cancel_session("s1");
        assert!(!a.is_cancelled());
        // 進捗も返らなくなる
        assert_eq!(jobs.rows("j1"), None);
    }

    #[test]
    fn 局面は進捗と一緒に返る() {
        let jobs = CsvJobs::default();
        let job = jobs.start("j1", "s1");
        job.set_rows(900_000);
        // 既定は本体の処理中
        let p = jobs.progress("j1").expect("登録中");
        assert_eq!(p.phase, JobPhase::Working);
        assert_eq!(p.rows, 900_000);

        /*
         * 取り消しに入ると件数は動かなくなる。
         * 局面を出さないと「900,000行 取り込み中」のまま固まって見える
         */
        job.set_phase(JobPhase::RollingBack);
        let p = jobs.progress("j1").expect("登録中");
        assert_eq!(p.phase, JobPhase::RollingBack);
        assert_eq!(p.rows, 900_000);

        job.set_phase(JobPhase::Committing);
        assert_eq!(jobs.progress("j1").unwrap().phase, JobPhase::Committing);

        // 終了後は返らない
        jobs.finish("j1", &job);
        assert!(jobs.progress("j1").is_none());
    }

    #[test]
    fn 進捗は登録している間だけ返る() {
        let jobs = CsvJobs::default();
        // 開始前は None (画面はこれを「完了」と解釈しないこと)
        assert_eq!(jobs.rows("j1"), None);
        let job = jobs.start("j1", "s1");
        job.set_rows(1234);
        assert_eq!(jobs.rows("j1"), Some(1234));
    }

    #[test]
    fn 終わったジョブが別のジョブの登録を消さない() {
        let jobs = CsvJobs::default();
        let a = jobs.start("j1", "s1");
        // 万一IDが重なった場合 (乱数なので通常は起きない)
        let b = jobs.start("j1", "s2");
        // 先に終わったAの後片付けが、走っているBを巻き込まない
        jobs.finish("j1", &a);
        assert_eq!(jobs.rows("j1"), Some(0));
        jobs.cancel("j1");
        assert!(b.is_cancelled());
    }

    #[test]
    fn 中止のあとに始めたジョブは巻き添えにならない() {
        let jobs = CsvJobs::default();
        let old = jobs.start("j1", "s1");
        jobs.cancel_session("s1");
        let new = jobs.start("j2", "s1");
        assert!(old.is_cancelled());
        assert!(!new.is_cancelled());
    }

    #[test]
    fn 動き出したジョブだけサーバーへ中止を送る() {
        let jobs = CsvJobs::default();
        let job = jobs.start("j1", "s1");
        // 接続を握る前は送らない (無関係なSQLを止めてしまうため)
        assert_eq!(jobs.running_session_of("j1"), None);
        job.mark_running();
        assert_eq!(jobs.running_session_of("j1").as_deref(), Some("s1"));
        // 終わったら引けない
        jobs.finish("j1", &job);
        assert_eq!(jobs.running_session_of("j1"), None);
    }

    #[test]
    fn 中止の要求は一度だけ真を返す() {
        let jobs = CsvJobs::default();
        let job = jobs.start("j1", "s1");
        assert!(jobs.cancel("j1"));
        // 連打してもサーバーへ何度も送らない
        assert!(!jobs.cancel("j1"));
        assert!(job.is_cancelled());
        assert!(!jobs.cancel("no-such-job"));
    }

    #[test]
    fn 未登録のidを指定しても何も起きない() {
        let jobs = CsvJobs::default();
        assert!(!jobs.cancel("no-such-job"));
        jobs.cancel_session("no-such-session");
        assert_eq!(jobs.rows("no-such-job"), None);
    }
}
