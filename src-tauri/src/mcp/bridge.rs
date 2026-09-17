//! `--mcp-stdio` の中継。
//!
//! Claude Desktop のように「コマンドを起動して stdin/stdout で話す」形しか
//! 設定できないクライアントのために、同じバイナリを `--mcp-stdio` 付きで
//! 起動すると、**Tauri を初期化せず (ウィンドウも出さず)**、
//! 起動中のQuelioのHTTPエンドポイントへそのまま流す。
//!
//! 守ること:
//! - **stdout には JSON-RPC 以外を1バイトも書かない**。
//!   混ざるとクライアント側の解析が壊れる。知らせごとは stderr へ
//! - ツールの定義をここに持たない。一覧も呼び出しもアプリ側へ丸ごと転送する
//!   (アプリ側でツールが増えたら、そのまま見えるようにするため)
//! - **上流が名乗るものは、全部転送できる状態にしておく**。
//!   名乗りはそのまま伝えるので、転送を忘れると
//!   「名乗るのに応えない」= クライアントは空だと思い込む
//! - 認証を緩めない。トークンはアプリと同じファイルから読み、必ず付けて送る

use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, ErrorData as McpError, GetPromptRequestParams,
    GetPromptResponse, InitializeResult, ListPromptsResult, ListResourceTemplatesResult,
    ListResourcesResult, ListToolsResult, PaginatedRequestParams, ProtocolVersion,
    ReadResourceRequestParams, ReadResourceResponse, ServerInfo,
};
use rmcp::service::{NotificationContext, Peer, RequestContext, RoleClient, RoleServer};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{stdio, StreamableHttpClientTransport};
use rmcp::{ClientHandler, ServerHandler, ServiceExt};

use super::endpoint;

/// 繋げなかったときにクライアントへ返すエラーの番号。
///
/// JSON-RPC の「実装側で決めてよい」範囲の先頭
const SERVER_ERROR: i32 = -32000;

/// 繋げなかったときの文言 (利用者がそのまま読む)
const NOT_RUNNING: &str = "Quelioが起動していないか、AI連携が無効です";

/// 応答が無いときの文言
const NO_ANSWER: &str = "Quelioが応答しません (ポートを別のアプリが使っている可能性があります)";

/// アプリ側と繋ぐのを待つ上限。
///
/// 同じPCの中なので、本来は一瞬で済む。
/// 止まっているだけなら接続を断られてすぐ返るが、
/// そのポートを別のアプリが掴んで黙っていると返ってこない。
/// クライアント (Claude Desktop) を初期化待ちで固まらせないよう、ここで切る
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(10);

/// 中継の本体。
///
/// 受けた要求を、そのままアプリ側 (HTTP) の相手へ流す。
/// `#[tool_router]` は使わない。ツールはアプリ側にあり、
/// ここでは何があるか分からない (コンパイル時に決まらない)
struct Bridge {
    /// アプリ側との話し相手
    upstream: Peer<RoleClient>,
}

impl ServerHandler for Bridge {
    /// 自分の名乗りは、アプリ側の名乗りをそのまま使う。
    ///
    /// `list_changed` の印もそのまま伝わる。
    /// **上流が名乗る口は、下からの要求をすべて転送できるようにしておくこと**
    /// (名乗るのに応えないと、クライアントは空だと思い込む)
    fn get_info(&self) -> ServerInfo {
        let Some(up) = self.upstream.peer_info() else {
            return ServerInfo::default();
        };
        let mut info = InitializeResult::new(up.capabilities.clone());
        info.protocol_version = up.protocol_version.clone();
        info.instructions = up.instructions.clone();
        if let Some(imp) = &up.server_info {
            info.server_info = imp.clone();
        }
        info
    }

    /// アプリ側が話せるものより新しい版を受けてしまわないようにする。
    ///
    /// 受けてしまうと、流した先で断られて「途中で失敗する」ことになる。
    /// 手前で下げておけば、ふつうの取り決め (ネゴシエーション) に収まる
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        match self.upstream.peer_info() {
            Some(up) => Cow::Owned(ProtocolVersion::known_up_to(&up.protocol_version).to_vec()),
            None => Cow::Owned(vec![ProtocolVersion::default()]),
        }
    }

    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        // 続きの目印 (cursor) もそのまま渡す
        self.upstream
            .list_tools(request)
            .await
            .map_err(|e| McpError::internal_error(e.to_string(), None))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        /*
         * `call_tool_once` を使う。
         *
         * こちらで後続のやり取りを代わりに進める `call_tool` だと、
         * アプリ側が「入力が要る」と返したときに飲み込んでしまう。
         * 中継は判断せず、返ってきたものをそのまま返す
         */
        self.upstream
            .call_tool_once(request)
            .await
            .map_err(|e| McpError::internal_error(e.to_string(), None))
    }

    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        self.upstream
            .list_resources(request)
            .await
            .map_err(|e| McpError::internal_error(e.to_string(), None))
    }

    async fn list_resource_templates(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, McpError> {
        self.upstream
            .list_resource_templates(request)
            .await
            .map_err(|e| McpError::internal_error(e.to_string(), None))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        /*
         * `call_tool` と同じ理由で `_once` 版を使う。
         * 「入力が要る」という返しを、中継が代わりに進めて飲み込まない。
         * URIが正しいかどうかも判断しない (断るのはアプリ側の仕事)
         */
        self.upstream
            .read_resource_once(request)
            .await
            .map_err(|e| McpError::internal_error(e.to_string(), None))
    }

    async fn list_prompts(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, McpError> {
        self.upstream
            .list_prompts(request)
            .await
            .map_err(|e| McpError::internal_error(e.to_string(), None))
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, McpError> {
        // 名前が正しいかどうかも判断しない (断るのはアプリ側の仕事)
        self.upstream
            .get_prompt_once(request)
            .await
            .map_err(|e| McpError::internal_error(e.to_string(), None))
    }
}

/**
 * 上流 (アプリ) からの知らせを、下流 (クライアント) へ流す役。
 *
 * 公開する接続を変えると、アプリは
 * `notifications/resources/list_changed` を送ってくる。
 * 受け手を置かないとここで捨てられ、クライアントは最初に取った一覧のまま話し続ける。
 *
 * 中継を張るのは上流に繋いだ後なので、下流の相手は後から入れる
 */
#[derive(Debug, Default)]
struct UpstreamEvents {
    downstream: Arc<Mutex<Option<Peer<RoleServer>>>>,
}

impl UpstreamEvents {
    /// 今の下流の相手 (まだ繋がっていなければ None)
    fn downstream(&self) -> Option<Peer<RoleServer>> {
        self.downstream.lock().ok()?.clone()
    }
}

impl ClientHandler for UpstreamEvents {
    async fn on_resource_list_changed(&self, _context: NotificationContext<RoleClient>) {
        if let Some(peer) = self.downstream() {
            // 送れなくても構わない (下流が閉じかけているだけ)
            let _ = peer.notify_resource_list_changed().await;
        }
    }

    /*
     * ツールとプロンプトの一覧の変更も流す。
     * 今のアプリは送らないが、送るようになったときに
     * 中継を直さなくても済むようにしておく
     */
    async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {
        if let Some(peer) = self.downstream() {
            let _ = peer.notify_tool_list_changed().await;
        }
    }

    async fn on_prompt_list_changed(&self, _context: NotificationContext<RoleClient>) {
        if let Some(peer) = self.downstream() {
            let _ = peer.notify_prompt_list_changed().await;
        }
    }
}

/// 繋げなかったときに1行だけ返す JSON-RPC のエラー。
///
/// 黙って終わるとクライアントは待ち続けるので、必ず形にして返す。
/// `id` は受け取った要求のものに合わせる (分からなければ null)
pub fn error_response(id: Option<serde_json::Value>, message: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(serde_json::Value::Null),
        "error": { "code": SERVER_ERROR, "message": message },
    })
    .to_string()
}

/// 受け取った1行から、要求の `id` を取り出す (無ければ None)
pub fn request_id(line: &str) -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    v.get("id").cloned()
}

/// 繋げないことを伝えて終わる。
///
/// クライアントは「初期化の返事」を待っているので、
/// 1行目を読んでその `id` に対して返す
fn reply_not_running(message: &str) {
    use std::io::{BufRead, Write};
    let mut line = String::new();
    // 1行目 (ふつうは initialize) を読んで、その id に返す
    let id = if std::io::stdin().lock().read_line(&mut line).is_ok() {
        request_id(&line)
    } else {
        None
    };
    let out = error_response(id, message);
    // ここだけは stdout へ書く (JSON-RPC そのものなので)
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{out}");
    let _ = stdout.flush();
    eprintln!("quelio --mcp-stdio: {message}");
}

/// `--mcp-stdio` で起動されたときの入口。
///
/// Tauri は一切初期化しない (ウィンドウ・プラグイン・メニューを通らない)
pub fn run() {
    // 中継だけのために、必要なぶんの実行環境を自分で作る
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            reply_not_running(&format!("{NOT_RUNNING} ({e})"));
            return;
        }
    };
    rt.block_on(async {
        if let Err(message) = relay(UPSTREAM_TIMEOUT).await {
            reply_not_running(&message);
        }
    });
}

/// アプリ側へ繋ぐ。
///
/// 待ち時間を引数にしてあるのは、待たずに試せるようにするため
async fn connect_upstream(
    url: String,
    token: String,
    timeout: Duration,
    events: UpstreamEvents,
) -> Result<rmcp::service::RunningService<RoleClient, UpstreamEvents>, String> {
    // auth_header は「Bearer を付けない生のトークン」を受ける決まり
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url).auth_header(token),
    );
    match tokio::time::timeout(timeout, events.serve(transport)).await {
        Ok(Ok(up)) => Ok(up),
        // 繋ぎに行けたが断られた (止まっている・トークンが違う)
        Ok(Err(e)) => Err(format!("{NOT_RUNNING} ({e})")),
        // 返事が来ない
        Err(_) => Err(NO_ANSWER.to_string()),
    }
}

/// 中継を張って、クライアントが閉じるまで流す
async fn relay(timeout: Duration) -> Result<(), String> {
    let Some(ep) = endpoint::read_without_tauri() else {
        return Err(NOT_RUNNING.to_string());
    };
    let Some(token) = read_token() else {
        return Err(format!("{NOT_RUNNING} (トークンが読めません)"));
    };

    // 上流からの知らせを下流へ流す役。下流の相手は中継を張ってから入れる
    let events = UpstreamEvents::default();
    let downstream = events.downstream.clone();
    let upstream = connect_upstream(ep.url(), token, timeout, events).await?;

    // stdin/stdout でクライアントの相手をする。受けたものは上へ流す
    let bridge = Bridge {
        upstream: upstream.peer().clone(),
    };
    let serving = bridge
        .serve(stdio())
        .await
        .map_err(|e| format!("中継を開始できません ({e})"))?;
    /*
     * ここで初めて下流の相手が決まる。
     * これより前に来た知らせは捨てている (初期化の途中で流す先が無い)
     */
    if let Ok(mut slot) = downstream.lock() {
        *slot = Some(serving.peer().clone());
    }

    // クライアントが stdin を閉じたら戻ってくる
    let _ = serving.waiting().await;
    // 上流のセッションも閉じる (開いたままにしない)
    let _ = upstream.cancel().await;
    Ok(())
}

/// アプリが使っているものと同じトークンを読む
fn read_token() -> Option<String> {
    let path = endpoint::config_dir_without_tauri()?.join(super::TOKEN_FILE);
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let token = v.get("token")?.as_str()?.to_string();
    (!token.is_empty()).then_some(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn エラー応答はjsonrpcの形になる() {
        let out = error_response(Some(serde_json::json!(1)), NOT_RUNNING);
        let v: serde_json::Value = serde_json::from_str(&out).expect("読めること");
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 1);
        assert_eq!(v["error"]["code"], SERVER_ERROR);
        assert_eq!(v["error"]["message"], NOT_RUNNING);
        // 1行で書く (JSON-RPC は行単位で読まれる)
        assert!(!out.contains('\n'), "{out}");
    }

    #[test]
    fn idが分からなければnullで返す() {
        // 相手が待てるよう、形だけは必ず返す
        let v: serde_json::Value =
            serde_json::from_str(&error_response(None, "だめ")).expect("読めること");
        assert!(v["id"].is_null());
    }

    #[tokio::test]
    async fn 応答が無ければ待たずに諦める() {
        /*
         * ポートは開いているのに返事が返ってこない状態を作る
         * (bind するだけで accept しない = 別のアプリが掴んでいるのと同じ)。
         * ここで待ち続けると、Claude Desktop が初期化待ちで固まる
         */
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("取れること");
        let port = listener.local_addr().expect("番号が取れること").port();

        let started = std::time::Instant::now();
        let err = connect_upstream(
            super::super::endpoint(port),
            "とーくん".to_string(),
            Duration::from_millis(200),
            UpstreamEvents::default(),
        )
        .await
        .expect_err("諦めること");

        assert_eq!(err, NO_ANSWER);
        // 上限で切れていること (待ち続けていない)
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
        drop(listener);
    }

    #[tokio::test]
    async fn 誰も待ち受けていなければ止まっている扱い() {
        // 空きポートを取ってすぐ手放す = 誰も居ない
        let probe = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("取れること");
        let port = probe.local_addr().expect("番号が取れること").port();
        drop(probe);

        let err = connect_upstream(
            super::super::endpoint(port),
            "とーくん".to_string(),
            Duration::from_secs(5),
            UpstreamEvents::default(),
        )
        .await
        .expect_err("諦めること");
        // 応答が無いのではなく、繋げない
        assert!(err.starts_with(NOT_RUNNING), "{err}");
    }

    #[test]
    fn 下流が決まる前は流す先が無い() {
        /*
         * 上流に繋いだ直後は、まだクライアントの相手が決まっていない。
         * その間に来た知らせは流す先が無いので捨てる (初期化の途中)
         */
        let events = UpstreamEvents::default();
        assert!(events.downstream().is_none());
    }

    #[test]
    fn 要求からidを取り出す() {
        assert_eq!(
            request_id(r#"{"jsonrpc":"2.0","id":7,"method":"initialize"}"#),
            Some(serde_json::json!(7))
        );
        // 文字列のidもある
        assert_eq!(
            request_id(r#"{"jsonrpc":"2.0","id":"a","method":"initialize"}"#),
            Some(serde_json::json!("a"))
        );
        // 壊れた行・idの無い通知では None
        assert_eq!(request_id("これはJSONではない"), None);
        assert_eq!(
            request_id(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#),
            None
        );
    }
}
