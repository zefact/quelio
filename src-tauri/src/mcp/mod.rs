//! MCPサーバー (AI連携) の起動と停止。
//!
//! Quelio自身をMCPサーバーにして、利用者がすでに使っているAIクライアント
//! (Claude Code / Claude Desktop / Cursor 等) から
//! 「Quelio経由で」DBを触れるようにする。
//!
//! 大事なのは、AI側に渡さないものを決めておくこと:
//! - 接続情報・パスワード・SSHトンネルは一切渡さない (AIが知るのは接続名だけ)
//! - 既存の安全装置 (読み取り専用判定・危険SQL判定・タイムアウト・SQLコンソールへの記録)
//!   をそのまま通す
//!
//! アプリが起動している間だけ動き、待受は `127.0.0.1` のみ

mod approval;
mod auth;
/// `--mcp-stdio` の中継 (stdio ⇄ HTTP)
pub mod bridge;
mod catalog;
mod editor;
mod endpoint;
mod prompts;
mod query;
mod resources;
mod rows;
mod server;
mod session;
mod values;
mod views;

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};

pub use approval::{respond as approval_respond, Approvals, PendingView, APPROVAL_TIMEOUT};
pub use auth::{load_or_create as token, regenerate as regenerate_token, TOKEN_FILE};
pub use resources::SQLITE_DB;
pub use session::{sweep_idle, AiSessions, SWEEP_INTERVAL};

/// 繋がっているAIクライアント (一覧が変わったことを知らせる相手)。
///
/// 「どんな接続を公開しているか」は利用者がいつでも変えられる。
/// 変わったことを伝えないと、クライアントは最初に取った一覧のまま話し続ける。
///
/// `Peer` は複製をそのまま持つ (弱参照にしない)。
/// `Peer` は送信側のハンドルで、持っていても相手のセッションの寿命は延びない。
/// 切れると送信路が閉じるので、`prune` で落とせる
#[derive(Default)]
pub struct Peers {
    list: Mutex<Vec<rmcp::service::Peer<rmcp::service::RoleServer>>>,
}

/// 生きているかどうかだけを見る (掃除の判断を型から切り離して試せるように)
trait Alive {
    fn alive(&self) -> bool;
}

impl Alive for rmcp::service::Peer<rmcp::service::RoleServer> {
    fn alive(&self) -> bool {
        !self.is_transport_closed()
    }
}

/// 切れた相手を落とす
fn prune<T: Alive>(list: &mut Vec<T>) {
    list.retain(Alive::alive);
}

impl Peers {
    /// 繋がってきた相手を覚える (ついでに切れた相手を落とす)
    fn add(&self, peer: rmcp::service::Peer<rmcp::service::RoleServer>) {
        if let Ok(mut list) = self.list.lock() {
            prune(&mut list);
            list.push(peer);
        }
    }

    /// 今つながっている相手を返す
    fn alive(&self) -> Vec<rmcp::service::Peer<rmcp::service::RoleServer>> {
        let Ok(mut list) = self.list.lock() else {
            return Vec::new();
        };
        prune(&mut list);
        list.clone()
    }

    /// 全部忘れる (待受を止めたとき。セッションごと切れている)
    fn clear(&self) {
        if let Ok(mut list) = self.list.lock() {
            list.clear();
        }
    }
}

/// 繋がってきたクライアントを覚える (`ServerHandler` の初期化完了から呼ぶ)
pub(crate) fn remember_peer(
    app: &AppHandle,
    peer: rmcp::service::Peer<rmcp::service::RoleServer>,
) {
    app.state::<McpServer>().peers.add(peer);
}

/// 「公開している接続の一覧が変わった」ことを知らせる。
///
/// ツールの並びは変わらないので `tools/list_changed` は送らない。
/// 変わるのは接続の一覧 = Resources の一覧の方
pub async fn notify_resources_changed(app: &AppHandle) {
    for peer in app.state::<McpServer>().peers.alive() {
        // 送れない相手は次の掃除で落ちる。ここでは止まらない
        let _ = peer.notify_resource_list_changed().await;
    }
}

/// 待っている許可の一覧 (画面が取りこぼしたときに取り直す)
pub fn pending_approvals(app: &AppHandle) -> Vec<PendingView> {
    app.state::<Approvals>().list(APPROVAL_TIMEOUT)
}

/// MCPのエンドポイント (AIクライアントの設定に書くパス)
pub const MCP_PATH: &str = "/mcp";

/// 使えるポートの下限。
///
/// 1024未満は特権ポートで、よく知られたサービスとも重なる。
/// 0 を許すとOSが空きポートを勝手に選んでしまい、
/// 設定画面に出している番号と実際の待受が食い違う
pub const MIN_PORT: u16 = 1024;

/// 待受を止めるとき、後始末を待つ上限。
///
/// これを超えたら打ち切る。待ち続けて画面が固まるよりはよい
const STOP_TIMEOUT: Duration = Duration::from_secs(3);

/// ポートの指定が使えないときの文言 (画面とRustで同じことを言う)
pub fn port_error(port: u16) -> String {
    format!("AI連携のポートは {MIN_PORT}〜65535 で指定してください (指定: {port})")
}

/// 使えるポートかを確かめる。
///
/// 画面 (設定 > AI連携) でも同じ範囲で絞っているが、ここでも見る。
/// 設定ファイルは手で書き換えられるし、
/// 片方だけの確認は、将来どちらかが外れたときに静かに穴になる
pub fn check_port(port: u16) -> Result<(), String> {
    if port < MIN_PORT {
        return Err(port_error(port));
    }
    Ok(())
}

/// 開いている待受1つぶん。
///
/// 設定やトークンの取り回しから切り離してあるので、
/// 「開いて閉じて、すぐ同じポートを開き直せるか」をここだけで試せる
struct Listening {
    /// 実際に開いているポート (要求値ではなく `local_addr` から取った値)
    port: u16,
    /// 止めるための合図 (rmcpのセッションも一緒に終わる)
    shutdown: CancellationToken,
    /// 待受のタスク。止めたあと、本当に終わるまで待つのに使う
    task: tokio::task::JoinHandle<()>,
}

/// 127.0.0.1 の指定ポートで待ち受け始める。
///
/// バインド先は `127.0.0.1` 固定。`0.0.0.0` にする道は用意しない
/// (LANの他の端末から叩けてしまうため)
async fn listen(
    port: u16,
    router: axum::Router,
    shutdown: CancellationToken,
) -> Result<Listening, String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| {
            format!("AI連携を待ち受けできません (ポート {port} が使われている可能性があります): {e}")
        })?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("AI連携の待受ポートを取得できません: {e}"))?
        .port();

    let signal = shutdown.clone();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move { signal.cancelled().await })
            .await;
    });
    Ok(Listening {
        port,
        shutdown,
        task,
    })
}

/// 待受を閉じ、**ポートが手放されるまで待つ**。
///
/// 合図を送っただけでは戻らない。
/// axum がポートを手放すのは、合図を受けたタスクが次に動いたとき。
/// すぐ戻ると、続けて同じポートを開こうとして
/// 「ポートが使われている」と弾かれることがある
/// (macOSは同じポートの開き直しに SO_REUSEPORT が要り、
///  Windowsは SO_REUSEADDR が付かない)。
///
/// 待ちきれなかったときは打ち切って、その旨を返す (黙って続けない)
async fn close(listening: Listening) -> Result<(), String> {
    let Listening {
        shutdown, mut task, ..
    } = listening;
    shutdown.cancel();
    if tokio::time::timeout(STOP_TIMEOUT, &mut task).await.is_err() {
        task.abort();
        return Err(
            "AI連携の待受を止めきれませんでした。ポートが空くまで少し待つか、アプリを再起動してください"
                .to_string(),
        );
    }
    Ok(())
}

/// 画面に出す状態
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    /// 設定で有効にしているか
    pub enabled: bool,
    /// 実際に待ち受けているか
    pub running: bool,
    /// 待受ポート (止まっているときは設定値)
    pub port: u16,
    /// 起動に失敗した理由 (ポートの重複など)。動いていれば null
    pub error: Option<String>,
}

/// 起動中のサーバーを持つ入れ物 (Tauriのstateとして1つだけ置く)
#[derive(Default)]
pub struct McpServer {
    running: Mutex<Option<Listening>>,
    /// 繋がっているクライアント (一覧の変更を知らせる相手)
    peers: Peers,
    /// 直近の起動が失敗した理由。次に起動できたら消す
    error: Mutex<Option<String>>,
    /*
     * 張り直しを1件ずつにするための順番待ち。
     *
     * 画面のトグル連打・トークンの作り直し・起動時の自動適用が重なると、
     * 「止める」と「開く」が入れ違い、同じポートを二重に開こうとして失敗する。
     * 入口をここで1本にしておく
     */
    gate: tokio::sync::Mutex<()>,
}

impl McpServer {
    fn set_error(&self, message: Option<String>) {
        if let Ok(mut e) = self.error.lock() {
            *e = message;
        }
    }

    fn error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|e| e.clone())
    }

    fn port(&self) -> Option<u16> {
        self.running.lock().ok()?.as_ref().map(|r| r.port)
    }
}

/// 設定に合わせて起動・停止する。
///
/// 起動時と、設定を保存したときに呼ぶ。
/// すでに同じポートで動いていても、いったん止めてから張り直す
/// (ポートやトークンだけ変えたときに、古い待受が残らないようにするため)
pub async fn apply(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<McpServer>();
    // 張り直しが重ならないよう、ここから先は1件ずつ通す
    let _gate = state.gate.lock().await;

    let settings = crate::app_settings::load(app)?;
    /*
     * 前回の終了時に残った待受情報を、まず消す。
     *
     * `stop` でしか消していないので、落ちたときには残る。
     * 残っていて、そのポートを別のアプリが掴んでいると、
     * 中継 (--mcp-stdio) がそちらへ繋ぎに行ってしまう。
     * これから開くなら書き直されるし、開かないなら消えたままでよい
     */
    endpoint::clear(app);
    stop(app).await;
    if !settings.mcp_enabled {
        state.set_error(None);
        return Ok(());
    }
    start(app, settings.mcp_port).await
}

/// 待受を始める。
///
/// トークンが読めない・ポートが使えないときは開かない
/// (認証なしで開くくらいなら、動かない方がよい)
pub async fn start(app: &AppHandle, port: u16) -> Result<(), String> {
    let state = app.state::<McpServer>();

    if let Err(message) = check_port(port) {
        state.set_error(Some(message.clone()));
        return Err(message);
    }

    let token = auth::load_or_create(app)?;

    /*
     * 中継 (--mcp-stdio) と設定フォルダの求め方が一致しているか。
     *
     * 食い違っていても待受は始める (HTTPで繋ぐクライアントには関係が無い)。
     * ただし黙って進まず、設定画面に理由を残す
     */
    let dir_warning = endpoint::check_same_dir(app).err();
    if let Some(w) = &dir_warning {
        eprintln!("AI連携: {w}");
    }

    let shutdown = CancellationToken::new();
    let handle = app.clone();
    let service = StreamableHttpService::new(
        move || Ok(server::QuelioMcp::new(handle.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_cancellation_token(shutdown.child_token())
            /*
             * 今のrmcpの既定と同じ内容だが、あえて書いておく。
             * 既定が広がっても、Quelioの待受は手元だけに留める
             */
            .with_allowed_hosts(["localhost", "127.0.0.1", "[::1]"]),
    );

    let guard = auth::Guard {
        token: token.into(),
    };
    let router = axum::Router::new()
        .nest_service(MCP_PATH, service)
        .layer(axum::middleware::from_fn_with_state(guard, auth::check));

    let listening = match listen(port, router, shutdown).await {
        Ok(l) => l,
        Err(message) => {
            state.set_error(Some(message.clone()));
            return Err(message);
        }
    };

    // 中継 (--mcp-stdio) がポートを知るための置き手紙。
    // 書けなくても待受は続ける (中継が使えないだけで、HTTPは繋がる)
    if let Err(e) = endpoint::write(app, port) {
        eprintln!("AI連携: 待受情報を書けません: {e}");
    }

    if let Ok(mut r) = state.running.lock() {
        *r = Some(listening);
    }
    // 待受は始まっているので、残すのは食い違いの警告だけ
    state.set_error(dir_warning);
    Ok(())
}

/// 待受を止める。
///
/// 合図を送るとAI用のセッションもまとめて終わる。
/// 止まっていれば何もしない
pub async fn stop(app: &AppHandle) {
    // 置き手紙を先に消す。
    // 残っていると、中継が「動いている」と思って繋ぎに行く
    endpoint::clear(app);

    let state = app.state::<McpServer>();
    // 待受が閉じればセッションごと切れるので、覚えている相手も捨てる
    state.peers.clear();
    let prev = state.running.lock().ok().and_then(|mut r| r.take());
    if let Some(listening) = prev {
        if let Err(message) = close(listening).await {
            state.set_error(Some(message));
        }
    }
    /*
     * AIが開いたDB接続は、待受を閉じてから切る。
     * 先に切ると、閉じ切るまでの隙間に来た呼び出しが
     * もう一度繋いでしまい、切ったはずのものが残る
     */
    session::close_all(app).await;
}

/// 画面に出す状態を作る
pub fn status(app: &AppHandle) -> Result<McpStatus, String> {
    let settings = crate::app_settings::load(app)?;
    let state = app.state::<McpServer>();
    let port = state.port();
    Ok(McpStatus {
        enabled: settings.mcp_enabled,
        running: port.is_some(),
        port: port.unwrap_or(settings.mcp_port),
        error: state.error(),
    })
}

/// AIクライアントに書いてもらうエンドポイントのURL
pub fn endpoint(port: u16) -> String {
    format!("http://127.0.0.1:{port}{MCP_PATH}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 掃除の判断だけを試すための当て馬
    struct Fake(bool);

    impl Alive for Fake {
        fn alive(&self) -> bool {
            self.0
        }
    }

    #[test]
    fn 切れた相手だけ落とす() {
        let mut list = vec![Fake(true), Fake(false), Fake(true)];
        prune(&mut list);
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|f| f.0));
    }

    #[test]
    fn 全部切れていれば空になる() {
        let mut list = vec![Fake(false), Fake(false)];
        prune(&mut list);
        assert!(list.is_empty());
    }

    #[test]
    fn エンドポイントは手元だけを指す() {
        let url = endpoint(41777);
        assert_eq!(url, "http://127.0.0.1:41777/mcp");
        // 外から届く宛先になっていないこと
        assert!(!url.contains("0.0.0.0"));
        assert!(!url.contains("localhost"));
    }

    #[test]
    fn 特権ポートと0は使わせない() {
        // 0 はOSが空きポートを選んでしまい、画面に出す番号と食い違う
        assert!(check_port(0).is_err());
        assert!(check_port(80).is_err());
        assert!(check_port(1023).is_err());
        assert!(check_port(MIN_PORT).is_ok());
        assert!(check_port(41777).is_ok());
    }

    #[test]
    fn 使えないポートの文言に指定値が入る() {
        // 画面に出したときに、何を直せばよいか分かるように
        assert!(port_error(80).contains("80"));
        assert!(port_error(80).contains("1024"));
    }

    /// 中身は何でもよい (ポートの開け閉めだけを見るため)
    fn router() -> axum::Router {
        axum::Router::new().route("/", axum::routing::get(|| async { "ok" }))
    }

    /// 空いているポートを1つ見つける (取ってすぐ手放す)
    async fn free_port() -> u16 {
        let probe = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("空きポートが取れること");
        let port = probe.local_addr().expect("番号が取れること").port();
        drop(probe);
        port
    }

    #[tokio::test]
    async fn 止めてすぐ同じポートを開き直せる() {
        /*
         * トグルの連打・トークンの作り直しで起きていた
         * 「ポートが使われている」の再現。
         * close がポートを手放すまで待つので、続けて開き直せる
         */
        let port = free_port().await;
        for i in 0..5 {
            let l = listen(port, router(), CancellationToken::new())
                .await
                .unwrap_or_else(|e| panic!("{i}回目に開けない: {e}"));
            assert_eq!(l.port, port);
            close(l).await.unwrap_or_else(|e| panic!("{i}回目に止められない: {e}"));
        }
    }

    #[tokio::test]
    async fn 実際に開いた番号を持つ() {
        let port = free_port().await;
        let l = listen(port, router(), CancellationToken::new())
            .await
            .expect("開けること");
        assert_eq!(l.port, port);
        assert_ne!(l.port, 0);
        close(l).await.expect("止められること");
    }

    #[tokio::test]
    async fn 使われているポートは開けない() {
        let holder = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("取れること");
        let port = holder.local_addr().expect("番号が取れること").port();
        let err = match listen(port, router(), CancellationToken::new()).await {
            Err(e) => e,
            Ok(_) => panic!("使われているポートが開けてしまった"),
        };
        assert!(err.contains(&port.to_string()), "{err}");
        drop(holder);
    }
}
