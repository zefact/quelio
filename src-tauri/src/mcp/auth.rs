//! MCPサーバーの入口の門番。
//!
//! 待受は 127.0.0.1 固定なので、外のネットワークからは直接届かない。
//! ここはその内側での取り違えを防ぐための2枚目・3枚目の壁:
//!
//! - **Bearerトークン**: このアプリが発行した1本だけを通す
//!   (同じPC上の別のプログラムが勝手に叩けないようにする)
//! - **Origin**: ブラウザで開いた悪意のあるページから
//!   `http://127.0.0.1:41777` を踏まれる (DNSリバインディング) のを防ぐ
//!
//! トークンは接続先やアプリ設定とは別のファイルに、所有者だけが読める形で置く

use std::sync::Arc;

use axum::{
    body::Body,
    extract::State,
    http::{header, Request, StatusCode},
    middleware::Next,
    response::Response,
};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// トークンを置くファイル名 (設定フォルダの中)。
///
/// 接続先やアプリ設定とは別のファイルにして、消しても他の設定が失われないようにする。
/// 中継 (`bridge`) も同じファイルから読む
pub const TOKEN_FILE: &str = "mcp_token.json";

/// トークンの長さ (バイト)。16進にして64文字になる
const TOKEN_BYTES: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenFile {
    token: String,
}

fn path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    crate::json_store::config_path(app, TOKEN_FILE)
}

/// 保存してあるトークンを読む。無ければ作って保存する。
///
/// 有効化のたびに作り直すと、AIクライアント側の設定が毎回無効になってしまうので、
/// 一度作ったものは作り直しを頼まれるまで使い続ける
pub fn load_or_create(app: &AppHandle) -> Result<String, String> {
    let p = path(app)?;
    if let Some(f) = crate::json_store::read::<TokenFile>(&p, "AI連携のトークン")? {
        if !f.token.is_empty() {
            return Ok(f.token);
        }
    }
    save(app, generate())
}

/// トークンを作り直す。古いトークンはこの瞬間から使えなくなる
pub fn regenerate(app: &AppHandle) -> Result<String, String> {
    save(app, generate())
}

fn save(app: &AppHandle, token: String) -> Result<String, String> {
    let p = path(app)?;
    let text = serde_json::to_string_pretty(&TokenFile {
        token: token.clone(),
    })
    .map_err(|e| format!("AI連携のトークンを組み立てられません: {e}"))?;
    // json_store::write は 0600 で作る (パスワードと同じ扱い)
    crate::json_store::write(&p, &text, "AI連携のトークン")?;
    Ok(token)
}

/// 推測できないトークンを作る。
///
/// 乱数はOSのものを使う (接続先の暗号化と同じ出どころ)
fn generate() -> String {
    use aes_gcm::aead::rand_core::RngCore;
    let mut buf = [0u8; TOKEN_BYTES];
    aes_gcm::aead::OsRng.fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// トークンを最後まで比べる。
///
/// 途中で違いが見つかっても抜けない。
/// 早く抜けると「何文字目まで合っていたか」が応答時間から漏れ、
/// 1文字ずつ総当たりできてしまう
pub fn token_matches(presented: &str, expected: &str) -> bool {
    let a = presented.as_bytes();
    let b = expected.as_bytes();
    // 長さは隠せない (隠す意味も無い)。中身の比較だけを一定時間にする
    if a.len() != b.len() || b.is_empty() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// `Authorization` ヘッダから Bearer トークンを取り出す
pub fn bearer(value: &str) -> Option<&str> {
    let rest = value.strip_prefix("Bearer ")?;
    let rest = rest.trim();
    if rest.is_empty() {
        None
    } else {
        Some(rest)
    }
}

/// Origin が手元 (localhost / 127.0.0.1 / ::1) のものか。
///
/// AIクライアント (CLI) は Origin を付けてこないので、
/// 「付いていれば見る」という形にする。
/// 付けてくるのはブラウザで、そこが危ないところなので確かめる意味がある
pub fn is_local_origin(origin: &str) -> bool {
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    if !matches!(scheme, "http" | "https" | "tauri") {
        return false;
    }
    // IPv6 は [::1]:port の形。ポートを外してからかっこを外す
    let host = if let Some(end) = rest.find(']') {
        &rest[..=end]
    } else {
        rest.split(':').next().unwrap_or(rest)
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// 門番が持つもの (発行済みのトークン)
#[derive(Clone)]
pub struct Guard {
    pub token: Arc<str>,
}

/// すべてのリクエストの手前で通す確認。
///
/// 返す番号は用途で分ける:
/// - トークンが無い・違う → 401 (名乗りが足りない)
/// - Origin が手元のものでない → 403 (名乗れても通さない)
pub async fn check(
    State(guard): State<Guard>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let headers = request.headers();

    // Origin は「付いていれば」見る
    if let Some(origin) = headers.get(header::ORIGIN) {
        let Ok(origin) = origin.to_str() else {
            return Err(StatusCode::BAD_REQUEST);
        };
        if !is_local_origin(origin) {
            return Err(StatusCode::FORBIDDEN);
        }
    }

    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(bearer)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !token_matches(presented, &guard.token) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(request).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn トークンは毎回違い十分に長い() {
        let a = generate();
        let b = generate();
        assert_ne!(a, b);
        assert_eq!(a.len(), TOKEN_BYTES * 2);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn 合っているときだけ通す() {
        let t = generate();
        assert!(token_matches(&t, &t));
        assert!(!token_matches("", &t));
        assert!(!token_matches(&t[..t.len() - 1], &t));
        let mut wrong = t.clone();
        wrong.pop();
        wrong.push(if t.ends_with('a') { 'b' } else { 'a' });
        assert!(!token_matches(&wrong, &t));
    }

    #[test]
    fn 期待側が空なら何も通さない() {
        // トークンを読めなかったときに「空文字なら通る」となってはいけない
        assert!(!token_matches("", ""));
        assert!(!token_matches("なにか", ""));
    }

    #[test]
    fn bearerの取り出し() {
        assert_eq!(bearer("Bearer abc"), Some("abc"));
        assert_eq!(bearer("Bearer  abc "), Some("abc"));
        assert_eq!(bearer("bearer abc"), None);
        assert_eq!(bearer("Basic abc"), None);
        assert_eq!(bearer("Bearer "), None);
        assert_eq!(bearer("abc"), None);
    }

    /// 門番だけを通した、中身が「ok」を返すだけの入口を作る
    fn app(token: &str) -> axum::Router {
        axum::Router::new()
            .route("/mcp", axum::routing::get(|| async { "ok" }))
            .layer(axum::middleware::from_fn_with_state(
                Guard {
                    token: token.into(),
                },
                check,
            ))
    }

    /// ヘッダを付けて1回だけ叩き、返ってきた番号を見る
    async fn call(token: &str, headers: &[(&str, &str)]) -> StatusCode {
        use tower::ServiceExt;
        let mut req = Request::builder().uri("/mcp");
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        app(token)
            .oneshot(req.body(Body::empty()).expect("組み立てられること"))
            .await
            .expect("応答があること")
            .status()
    }

    #[tokio::test]
    async fn トークンが無ければ401() {
        assert_eq!(call("tok", &[]).await, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn トークンが違えば401() {
        assert_eq!(
            call("tok", &[("authorization", "Bearer ちがう")]).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn bearer以外の名乗り方は401() {
        assert_eq!(
            call("tok", &[("authorization", "Basic tok")]).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn トークンが合っていれば通る() {
        assert_eq!(
            call("tok", &[("authorization", "Bearer tok")]).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn 外のoriginは403_トークンが合っていても通さない() {
        assert_eq!(
            call(
                "tok",
                &[
                    ("authorization", "Bearer tok"),
                    ("origin", "http://evil.example.com"),
                ],
            )
            .await,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn 手元のoriginなら通る() {
        assert_eq!(
            call(
                "tok",
                &[
                    ("authorization", "Bearer tok"),
                    ("origin", "http://127.0.0.1:41777"),
                ],
            )
            .await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn originが不正でもトークンが無ければ通さない() {
        // 順番を入れ替えても、どちらか一方だけで通ることは無い
        assert_eq!(
            call("tok", &[("origin", "http://127.0.0.1")]).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[test]
    fn 手元のoriginだけ通す() {
        for ok in [
            "http://localhost",
            "http://localhost:1420",
            "http://127.0.0.1:41777",
            "https://127.0.0.1",
            "http://[::1]:8080",
            "tauri://localhost",
        ] {
            assert!(is_local_origin(ok), "{ok} は通るはず");
        }
        for ng in [
            "http://example.com",
            "https://evil.example.com:41777",
            // 手元の名前を頭に付けただけのホスト名に釣られない
            "http://localhost.evil.com",
            "http://127.0.0.1.evil.com",
            "file://",
            "null",
            "",
        ] {
            assert!(!is_local_origin(ng), "{ng} は弾くはず");
        }
    }
}
