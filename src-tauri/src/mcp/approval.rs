//! 更新を実行してよいかを、人に聞いて待つところ。
//!
//! AIが更新系のSQLを投げてきたとき、Quelioが勝手に実行しない。
//! 画面にダイアログを出し、利用者が「許可」を押すまで **AI側を待たせる**。
//!
//! 待ちっぱなしにはしない。応答が無ければ一定時間で拒否に倒す
//! (画面を閉じている・席を外している間に通ってしまう方が危ない)。
//!
//! 待ち行列はこのモジュールだけが持つ。
//! 画面とのやり取りは Tauri のイベントとコマンドで行う

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::query::DangerousStatement;

/// 画面へ知らせるイベント名
pub const APPROVAL_EVENT: &str = "mcp-approval";

/// 応答を待つ上限。
///
/// 設定にはしない。短くすると席を立った隙に拒否になって使いにくく、
/// 長くするとAI側がいつまでも待たされる。
/// 「席に戻って押せる」程度に収めて固定する
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);

/// 待っている要求を知らないと言われたときの文言
pub const UNKNOWN_REQUEST: &str = "その要求は既に終わっています";

/// 人が拒否したときにAIへ返す文言
pub const DENIED: &str = "利用者が実行を拒否しました";

/// 時間内に応答が無かったときにAIへ返す文言
pub const TIMED_OUT: &str = "時間内に許可されなかったため実行しませんでした";

/// 人の判断
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    Denied,
    TimedOut,
}

impl Decision {
    /// SQLコンソールに残す言い回し
    pub fn note(self) -> &'static str {
        match self {
            Decision::Allowed => "更新を許可",
            Decision::Denied => "更新を拒否",
            Decision::TimedOut => "時間切れで拒否",
        }
    }
}

/// ダイアログに出す内容
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    /// 応答を返すときの目印
    pub request_id: String,
    /// 接続名 (`[AI] ` は付けない。画面には接続そのものの名前を出す)
    pub connection: String,
    /// 環境ラベル ("prod" / "staging" / "dev"。未設定なら null)
    pub env: Option<String>,
    /// 対象のデータベース (空なら既定)
    pub database: String,
    /// 実行しようとしているSQL (全文)
    pub sql: String,
    /// 危険なSQLの判定結果 (既存の確認ダイアログと同じ内容)
    pub dangerous: Vec<DangerousStatement>,
    /// 残り何秒待つか (画面のカウントダウン用)
    pub remaining_secs: u64,
}

/// 許可を求めるときに渡す内容
pub struct Request {
    pub connection: String,
    pub env: Option<String>,
    pub database: String,
    pub sql: String,
    pub dangerous: Vec<DangerousStatement>,
}

/// 待っている1件
struct Pending {
    view: PendingView,
    /// 画面からの応答を渡す先
    reply: oneshot::Sender<bool>,
    /// 登録した時刻 (残り時間の計算に使う)
    since: Instant,
}

/// 待っている要求の置き場 (Tauriのstateとして1つだけ置く)
#[derive(Default)]
pub struct Approvals {
    pending: Mutex<HashMap<String, Pending>>,
}

impl Approvals {
    /// 待っている件数 (試すときに、片付いたかを見るのに使う)
    #[cfg(test)]
    fn len(&self) -> usize {
        self.pending.lock().map(|m| m.len()).unwrap_or(0)
    }

    /// 待っている一覧 (残り時間を今の時刻で計算し直して返す)
    pub fn list(&self, timeout: Duration) -> Vec<PendingView> {
        let Ok(m) = self.pending.lock() else {
            return Vec::new();
        };
        let mut out: Vec<PendingView> = m
            .values()
            .map(|p| PendingView {
                remaining_secs: remaining_secs(p.since, Instant::now(), timeout),
                ..p.view.clone()
            })
            .collect();
        // 古いものから出す (画面は1件ずつ出すので、順番が要る)
        out.sort_by_key(|v| v.request_id.clone());
        out
    }
}

/// 残り秒数 (切り上げ。0になったら時間切れ)
fn remaining_secs(since: Instant, now: Instant, timeout: Duration) -> u64 {
    timeout.saturating_sub(now.duration_since(since)).as_secs()
}

/// 目印に付ける通し番号。
///
/// 同じミリ秒に2件来ることはある。
/// 時刻だけでは並びが決まらないので、必ず増える番号を後ろに付ける
static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 要求の目印を作る。
///
/// 並べると受け取った順になる (画面は先頭から1件ずつ出せばよい)。
/// 時刻を頭に置いてあるのは、記録を読むときに分かりやすいため
fn new_id() -> String {
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!(
        "{}-{seq:012}",
        chrono::Local::now().format("%Y%m%d%H%M%S%3f")
    )
}

/// 許可を求めて待つ (画面を持たない中核)。
///
/// `AppHandle` を受けないので、そのまま試せる。
/// `announce` は「画面へ知らせる」ところで、届かなくても待ちは続く
/// (誰も見ていなければ時間切れで拒否になる)
pub async fn request_on(
    approvals: &Approvals,
    req: Request,
    timeout: Duration,
    announce: impl FnOnce(&PendingView),
) -> Decision {
    let (tx, rx) = oneshot::channel();
    let id = new_id();
    let view = PendingView {
        request_id: id.clone(),
        connection: req.connection,
        env: req.env,
        database: req.database,
        sql: req.sql,
        dangerous: req.dangerous,
        remaining_secs: timeout.as_secs(),
    };

    {
        let Ok(mut m) = approvals.pending.lock() else {
            // 置き場を触れないときは通さない (安全側)
            return Decision::Denied;
        };
        m.insert(
            id.clone(),
            Pending {
                view: view.clone(),
                reply: tx,
                since: Instant::now(),
            },
        );
    }
    announce(&view);

    let decision = match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(true)) => Decision::Allowed,
        // 拒否、または待っている間に置き場が消えた (送り手が落ちた)
        Ok(_) => Decision::Denied,
        Err(_) => Decision::TimedOut,
    };

    // 結果がどうであれ、待ち行列からは外す
    if let Ok(mut m) = approvals.pending.lock() {
        m.remove(&id);
    }
    decision
}

/// 許可を求めて待つ。
///
/// `timeout` を引数にしてあるのは、待たずに試せるようにするため。
/// 呼ぶ側は `APPROVAL_TIMEOUT` を渡す
pub async fn request(app: &AppHandle, req: Request, timeout: Duration) -> Decision {
    let approvals = app.state::<Approvals>();
    request_on(&approvals, req, timeout, |view| {
        /*
         * 本体のウィンドウだけへ送る。
         * 別ウィンドウ (CSVエディタ・ER図) に出しても、そこにダイアログは無い。
         * ウィンドウが無い・閉じているときは届かないが、
         * そのまま待って時間切れで拒否になる (安全側)
         */
        let _ = app.emit_to("main", APPROVAL_EVENT, view);
        notify_user(app);
    })
    .await
}

/// 画面へ「見てほしい」と知らせる。
///
/// フォーカスは奪わない。作業中に前面へ出てくると、
/// そのとき打っていたキーがダイアログに入ってしまう
fn notify_user(app: &AppHandle) {
    use tauri::UserAttentionType;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.request_user_attention(Some(UserAttentionType::Informational));
    }
}

/// 画面からの応答を、待っている側へ届ける (中核)
pub fn respond_on(
    approvals: &Approvals,
    request_id: &str,
    allow: bool,
) -> Result<(), String> {
    let mut m = approvals
        .pending
        .lock()
        .map_err(|_| "許可待ちの状態を読めません".to_string())?;
    // 二重に押された・時間切れのあとに押された場合もここへ来る
    let pending = m.remove(request_id).ok_or(UNKNOWN_REQUEST)?;
    pending
        .reply
        .send(allow)
        .map_err(|_| UNKNOWN_REQUEST.to_string())
}

/// 画面からの応答を、待っている側へ届ける
pub fn respond(app: &AppHandle, request_id: &str, allow: bool) -> Result<(), String> {
    respond_on(&app.state::<Approvals>(), request_id, allow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 残り秒数は減っていき0で止まる() {
        let now = Instant::now();
        let t = Duration::from_secs(120);
        assert_eq!(remaining_secs(now, now, t), 120);
        assert_eq!(remaining_secs(now - Duration::from_secs(30), now, t), 90);
        // 過ぎても負にはならない
        assert_eq!(remaining_secs(now - Duration::from_secs(500), now, t), 0);
    }

    #[test]
    fn 目印は毎回違い並べると受け取った順になる() {
        // 同じミリ秒に続けて作っても、順番が入れ替わらないこと
        let ids: Vec<String> = (0..5).map(|_| new_id()).collect();
        let unique: std::collections::HashSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "{ids:?}");
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(sorted, ids, "作った順に並ぶこと");
    }

    fn req() -> Request {
        Request {
            connection: "開発DB".into(),
            env: Some("dev".into()),
            database: "appdb".into(),
            sql: "UPDATE users SET name = 'a' WHERE id = 1".into(),
            dangerous: Vec::new(),
        }
    }

    /// 出された要求の目印を受け取りながら待つ
    async fn ask(
        approvals: &Approvals,
        timeout: Duration,
        answer: Option<bool>,
    ) -> Decision {
        let (idtx, idrx) = oneshot::channel();
        let wait = request_on(approvals, req(), timeout, move |v| {
            let _ = idtx.send(v.request_id.clone());
        });
        let answering = async {
            let id = idrx.await.expect("目印が来ること");
            if let Some(allow) = answer {
                respond_on(approvals, &id, allow).expect("届くこと");
            }
        };
        let (decision, ()) = tokio::join!(wait, answering);
        decision
    }

    #[tokio::test]
    async fn 許可すれば通る() {
        let a = Approvals::default();
        assert_eq!(ask(&a, Duration::from_secs(5), Some(true)).await, Decision::Allowed);
        // 終わった要求は残さない
        assert_eq!(a.len(), 0);
    }

    #[tokio::test]
    async fn 拒否すれば通らない() {
        let a = Approvals::default();
        assert_eq!(
            ask(&a, Duration::from_secs(5), Some(false)).await,
            Decision::Denied
        );
        assert_eq!(a.len(), 0);
    }

    #[tokio::test]
    async fn 応答が無ければ時間切れで拒否になる() {
        let a = Approvals::default();
        // 誰も押さない = 画面を見ていない・閉じている
        assert_eq!(
            ask(&a, Duration::from_millis(50), None).await,
            Decision::TimedOut
        );
        // 時間切れのあとに登録が残っていると、押せないダイアログが出続ける
        assert_eq!(a.len(), 0);
    }

    #[tokio::test]
    async fn 知らない目印への応答は断る() {
        let a = Approvals::default();
        assert_eq!(
            respond_on(&a, "ありません", true).expect_err("断ること"),
            UNKNOWN_REQUEST
        );
    }

    #[tokio::test]
    async fn 二度目の応答は断る() {
        let a = Approvals::default();
        let (idtx, idrx) = oneshot::channel();
        let wait = request_on(&a, req(), Duration::from_secs(5), move |v| {
            let _ = idtx.send(v.request_id.clone());
        });
        let answering = async {
            let id = idrx.await.expect("目印が来ること");
            respond_on(&a, &id, false).expect("1回目は届くこと");
            // 連打・時間切れのあとの押下がここへ来る
            assert_eq!(
                respond_on(&a, &id, true).expect_err("断ること"),
                UNKNOWN_REQUEST
            );
        };
        let (decision, ()) = tokio::join!(wait, answering);
        assert_eq!(decision, Decision::Denied);
    }

    #[tokio::test]
    async fn 待っている間は一覧に出る() {
        let a = Approvals::default();
        let (idtx, idrx) = oneshot::channel();
        let wait = request_on(&a, req(), Duration::from_secs(5), move |v| {
            let _ = idtx.send(v.request_id.clone());
        });
        let answering = async {
            let id = idrx.await.expect("目印が来ること");
            let list = a.list(Duration::from_secs(5));
            assert_eq!(list.len(), 1);
            assert_eq!(list[0].request_id, id);
            assert_eq!(list[0].connection, "開発DB");
            assert!(list[0].remaining_secs > 0);
            respond_on(&a, &id, false).expect("届くこと");
        };
        let (_, ()) = tokio::join!(wait, answering);
        assert!(a.list(Duration::from_secs(5)).is_empty());
    }

    #[test]
    fn 記録に残す言い回し() {
        assert_eq!(Decision::Allowed.note(), "更新を許可");
        assert_eq!(Decision::Denied.note(), "更新を拒否");
        assert_eq!(Decision::TimedOut.note(), "時間切れで拒否");
    }
}
