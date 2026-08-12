use std::sync::{Arc, Mutex};

use russh::client;
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey};
use tokio::net::TcpListener;

use crate::known_hosts;
use crate::models::SshConfig;

/// SSHクライアントのイベントハンドラ (TOFU方式でホスト鍵を検証する)
struct ClientHandler {
    host: String,
    port: u16,
    /// 鍵の不一致で拒否した場合の理由 (open_tunnel側でエラー文言に使う)
    reject_reason: Arc<Mutex<Option<String>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        match known_hosts::verify(&self.host, self.port, &fingerprint) {
            Ok(()) => Ok(true),
            Err(reason) => {
                *self.reject_reason.lock().unwrap() = Some(reason);
                Ok(false)
            }
        }
    }
}

/// ローカルポート → SSH踏み台 → DBサーバー のトンネル。
/// close()でSSHのDisconnectメッセージを送ってから閉じる。
/// Dropにフォールバックした場合は転送タスクの中断のみ行う。
pub struct SshTunnel {
    pub local_port: u16,
    handle: Arc<client::Handle<ClientHandler>>,
    task: tokio::task::JoinHandle<()>,
}

impl SshTunnel {
    /// SSHプロトコルに則ってDisconnectメッセージを送ってから閉じる
    pub async fn close(&mut self) {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            self.handle
                .disconnect(russh::Disconnect::ByApplication, "closed by Quelio", "en"),
        )
        .await;
        self.task.abort();
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// SSH踏み台に接続し、target_host:target_port へのトンネルを開く
pub async fn open_tunnel(
    cfg: &SshConfig,
    target_host: String,
    target_port: u16,
) -> Result<SshTunnel, String> {
    // 1. 踏み台へTCP+SSH接続 (ホスト鍵はTOFU方式で検証)
    let config = Arc::new(client::Config::default());
    let reject_reason = Arc::new(Mutex::new(None));
    let handler = ClientHandler {
        host: cfg.host.clone(),
        port: cfg.port,
        reject_reason: Arc::clone(&reject_reason),
    };
    let mut session = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        client::connect(config, (cfg.host.as_str(), cfg.port), handler),
    )
    .await
    .map_err(|_| format!("SSH接続がタイムアウトしました ({}:{})", cfg.host, cfg.port))?
        .map_err(|e| {
            // ホスト鍵不一致で拒否した場合は詳しい理由を出す
            if let Some(reason) = reject_reason.lock().unwrap().take() {
                reason
            } else {
                format!("SSH接続に失敗 ({}:{}): {e}", cfg.host, cfg.port)
            }
        })?;

    // 2. 秘密鍵で認証
    let passphrase = cfg.passphrase.as_deref().filter(|s| !s.is_empty());
    let key_path = shellexpand_tilde(&cfg.key_path);
    let key = load_secret_key(&key_path, passphrase)
        .map_err(|e| format!("秘密鍵を読み込めません ({key_path}): {e}"))?;

    let rsa_hash = session
        .best_supported_rsa_hash()
        .await
        .map_err(|e| format!("SSHネゴシエーションに失敗: {e}"))?
        .flatten();

    let auth = session
        .authenticate_publickey(
            cfg.user.clone(),
            PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash),
        )
        .await
        .map_err(|e| format!("SSH認証でエラー: {e}"))?;

    if !auth.success() {
        return Err("SSH認証に失敗しました。ユーザー名・秘密鍵・パスフレーズを確認してください".into());
    }

    // 3. ローカルの空きポートで待ち受け、接続ごとにdirect-tcpipチャネルへ中継
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("ローカルポートを確保できません: {e}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    // Handleは切断通知(close)用にも保持するためArcで共有する
    let handle = Arc::new(session);
    let task_handle = Arc::clone(&handle);

    let task = tokio::spawn(async move {
        loop {
            let Ok((mut local_stream, _)) = listener.accept().await else {
                break;
            };
            let channel = match task_handle
                .channel_open_direct_tcpip(
                    target_host.clone(),
                    u32::from(target_port),
                    "127.0.0.1",
                    0,
                )
                .await
            {
                Ok(ch) => ch,
                Err(_) => break,
            };
            tokio::spawn(async move {
                let mut remote_stream = channel.into_stream();
                let _ =
                    tokio::io::copy_bidirectional(&mut local_stream, &mut remote_stream).await;
            });
        }
    });

    Ok(SshTunnel {
        local_port,
        handle,
        task,
    })
}

/// 先頭の `~` をホームディレクトリに展開する
fn shellexpand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return format!("{}/{}", home.to_string_lossy(), rest);
        }
    }
    path.to_string()
}
