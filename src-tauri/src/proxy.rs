//! 外部のCLIを起動して、ローカルポートへ転送させる接続経路。
//!
//! 踏み台へのSSHを禁止し、AWS Systems Manager (SSM) や
//! Cloud SQL Auth Proxy を使う運用が増えている。
//! どちらも「CLIがローカルポートで待ち受け、その先へ中継する」形なので、
//! 起動と後始末だけをここで受け持ち、接続そのものは 127.0.0.1 への接続になる

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};

use crate::models::ProxyConfig;
use crate::ssh_tunnel::SshTunnel;
use crate::tools;

/// 転送が始まるまで待つ時間
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// 転送先が開いたか確かめる間隔
const POLL: Duration = Duration::from_millis(150);
/// 失敗の説明に使う、CLIの出力の行数
const KEEP_LINES: usize = 30;

/// 経路の種類 (設定の文字列から読む)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyKind {
    /// AWS Systems Manager のポート転送
    Ssm,
    /// Cloud SQL Auth Proxy
    CloudSql,
}

impl ProxyKind {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "ssm" => Ok(Self::Ssm),
            "cloudsql" => Ok(Self::CloudSql),
            other => Err(format!("不明な接続経路です: {other}")),
        }
    }

    /// 既定で探す実行ファイルの名前
    pub fn program(self) -> &'static str {
        match self {
            Self::Ssm => "aws",
            Self::CloudSql => "cloud-sql-proxy",
        }
    }

    /// 画面やエラー文言に出す名前
    pub fn label(self) -> &'static str {
        match self {
            Self::Ssm => "AWS SSM",
            Self::CloudSql => "Cloud SQL Auth Proxy",
        }
    }
}

/// CLIに渡す引数を組み立てる。
///
/// 実際に起動せずに確かめられるよう、ここは文字列を作るだけにしてある
pub fn build_args(
    cfg: &ProxyConfig,
    target_host: &str,
    target_port: u16,
    local_port: u16,
) -> Result<Vec<String>, String> {
    let kind = ProxyKind::parse(&cfg.kind)?;
    let s = |v: &str| v.trim().to_string();
    match kind {
        ProxyKind::Ssm => {
            let target = s(&cfg.target);
            if target.is_empty() {
                return Err("SSMの接続先 (インスタンスID) を入力してください".into());
            }
            if target_host.trim().is_empty() {
                return Err("接続先のホスト名を入力してください".into());
            }
            /*
             * 転送先はDBのホスト:ポート。ローカルの待ち受けポートはこちらで決める。
             *
             * 手で組み立てると、ホスト名に `"` が入ったときにJSONが壊れる。
             * (シェルは経由していないのでコマンドは足せないが、
             *  読めないパラメータをCLIへ渡すことになる)
             */
            let params = serde_json::json!({
                "host": [target_host.trim()],
                "portNumber": [target_port.to_string()],
                "localPortNumber": [local_port.to_string()],
            })
            .to_string();
            let mut args = vec![
                "ssm".into(),
                "start-session".into(),
                "--target".into(),
                target,
                "--document-name".into(),
                "AWS-StartPortForwardingSessionToRemoteHost".into(),
                "--parameters".into(),
                params,
            ];
            let region = s(&cfg.region);
            if !region.is_empty() {
                args.push("--region".into());
                args.push(region);
            }
            let profile = s(&cfg.profile);
            if !profile.is_empty() {
                args.push("--profile".into());
                args.push(profile);
            }
            Ok(args)
        }
        ProxyKind::CloudSql => {
            let instance = s(&cfg.instance);
            if instance.is_empty() {
                return Err(
                    "Cloud SQL のインスタンス接続名 (プロジェクト:リージョン:インスタンス) を入力してください".into(),
                );
            }
            if instance.matches(':').count() != 2 {
                return Err(format!(
                    "インスタンス接続名は「プロジェクト:リージョン:インスタンス」の形で入力してください ({instance})"
                ));
            }
            let mut args = vec![
                "--address".into(),
                "127.0.0.1".into(),
                "--port".into(),
                local_port.to_string(),
            ];
            let cred = s(&cfg.credentials_path);
            if !cred.is_empty() {
                args.push("--credentials-file".into());
                args.push(cred);
            }
            if cfg.auto_iam {
                args.push("--auto-iam-authn".into());
            }
            args.push(instance);
            Ok(args)
        }
    }
}

/// 起動したCLI。落とすまでポート転送が続く
pub struct ProxyProcess {
    pub local_port: u16,
    child: Child,
    label: &'static str,
    /// CLIが出したメッセージ (失敗の説明に使う)
    output: Arc<Mutex<Vec<String>>>,
}

impl ProxyProcess {
    /// CLIの直近の出力 (エラーの手がかり)
    pub fn recent_output(&self) -> String {
        self.output.lock().unwrap().join("\n")
    }

    /// 転送先から切られたときに出す説明 (SSHトンネルと合わせた形)
    pub fn take_error(&self) -> Option<String> {
        None
    }

    /// CLIを終わらせる
    pub async fn close(&mut self) {
        kill_tree(&mut self.child);
        // 後始末を待つ (待たないとゾンビが残る)
        let _ = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
    }
}

impl Drop for ProxyProcess {
    fn drop(&mut self) {
        kill_tree(&mut self.child);
    }
}

/// CLIとその子プロセスをまとめて終わらせる。
///
/// `aws ssm start-session` は session-manager-plugin を子として起動するので、
/// 親だけを落とすと転送が残ってしまう。
/// Unixではプロセスグループごと、Windowsでは親のみを落とす
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            // 起動時に自分をグループリーダーにしてあるので、負のPIDで一族に届く
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
        }
    }
    let _ = child.start_kill();
}

/// 使えるローカルポートを1つ選ぶ。
///
/// 0番で一度bindして番号だけもらい、すぐ閉じてCLIに渡す
async fn pick_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("ローカルポートを確保できません: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

/// 使う実行ファイルを決める (設定が空なら PATH と決まった場所から探す)
fn resolve_program(cfg: &ProxyConfig, kind: ProxyKind) -> Result<PathBuf, String> {
    let (path, _) = tools::find_tool(&cfg.command_path, kind.program());
    path.ok_or_else(|| {
        let hint = match kind {
            ProxyKind::Ssm => concat!(
                "AWS CLI と Session Manager プラグインが要ります\n",
                "macOS: brew install awscli && brew install --cask session-manager-plugin"
            ),
            ProxyKind::CloudSql => concat!(
                "Cloud SQL Auth Proxy が要ります\n",
                "macOS: brew install cloud-sql-proxy"
            ),
        };
        format!(
            "{} が見つかりません。接続設定でパスを指定するか、インストールしてください\n{}",
            kind.program(),
            hint
        )
    })
}

/// CLIを起動し、転送が始まるまで待つ
pub async fn start(
    cfg: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<ProxyProcess, String> {
    let kind = ProxyKind::parse(&cfg.kind)?;
    let program = resolve_program(cfg, kind)?;
    let local_port = pick_port().await?;
    let args = build_args(cfg, target_host, target_port, local_port)?;

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        // 子プロセスごと落とせるよう、自分をグループリーダーにする
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{} を起動できません ({}): {e}", kind.label(), program.display()))?;

    let output = Arc::new(Mutex::new(Vec::new()));
    read_lines(child.stdout.take(), Arc::clone(&output));
    read_lines(child.stderr.take(), Arc::clone(&output));

    let proc = ProxyProcess {
        local_port,
        child,
        label: kind.label(),
        output,
    };
    wait_ready(proc).await
}

/// CLIの出力を読み続けて、直近の数十行だけ覚えておく
fn read_lines<R>(pipe: Option<R>, out: Arc<Mutex<Vec<String>>>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let Some(pipe) = pipe else { return };
    tokio::spawn(async move {
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut buf = out.lock().unwrap();
            if buf.len() >= KEEP_LINES {
                buf.remove(0);
            }
            buf.push(line);
        }
    });
}

/// ローカルポートが繋がるようになるまで待つ (CLIが先に終わったら失敗)
async fn wait_ready(mut proc: ProxyProcess) -> Result<ProxyProcess, String> {
    let started = std::time::Instant::now();
    loop {
        // CLIが先に終わっていたら、その出力を理由として返す
        if let Ok(Some(status)) = proc.child.try_wait() {
            let msg = proc.recent_output();
            return Err(format!(
                "{} が終了しました ({status})\n{}",
                proc.label,
                if msg.is_empty() { "(出力なし)".into() } else { msg }
            ));
        }
        if TcpStream::connect(("127.0.0.1", proc.local_port)).await.is_ok() {
            return Ok(proc);
        }
        if started.elapsed() > READY_TIMEOUT {
            let msg = proc.recent_output();
            proc.close().await;
            return Err(format!(
                "{} の転送が始まりませんでした (30秒待ちました)\n{}",
                "接続経路",
                if msg.is_empty() { "(出力なし)".into() } else { msg }
            ));
        }
        tokio::time::sleep(POLL).await;
    }
}

/// ローカルポートへの転送のしかた (SSHトンネル or 外部CLI)
pub enum Forwarder {
    Ssh(SshTunnel),
    Cli(ProxyProcess),
}

impl Forwarder {
    pub fn local_port(&self) -> u16 {
        match self {
            Self::Ssh(t) => t.local_port,
            Self::Cli(p) => p.local_port,
        }
    }

    /// 転送先へ届かなかったときの説明 (あれば)
    pub fn take_error(&self) -> Option<String> {
        match self {
            Self::Ssh(t) => t.take_error(),
            Self::Cli(p) => p.take_error(),
        }
    }

    pub async fn close(&mut self) {
        match self {
            Self::Ssh(t) => t.close().await,
            Self::Cli(p) => p.close().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssm() -> ProxyConfig {
        ProxyConfig {
            enabled: true,
            kind: "ssm".into(),
            target: "i-0123456789abcdef0".into(),
            region: String::new(),
            profile: String::new(),
            instance: String::new(),
            credentials_path: String::new(),
            auto_iam: false,
            command_path: String::new(),
        }
    }

    fn cloudsql() -> ProxyConfig {
        ProxyConfig {
            kind: "cloudsql".into(),
            target: String::new(),
            instance: "my-proj:asia-northeast1:main".into(),
            ..ssm()
        }
    }

    #[test]
    fn ssmはポート転送の文書と引数を組み立てる() {
        let args = build_args(&ssm(), "db.internal", 3306, 54321).unwrap();
        assert_eq!(args[0], "ssm");
        assert_eq!(args[1], "start-session");
        assert!(args.contains(&"AWS-StartPortForwardingSessionToRemoteHost".to_string()));
        assert!(args.contains(&"i-0123456789abcdef0".to_string()));
        let params = args.last().unwrap();
        assert!(params.contains(r#""host":["db.internal"]"#), "{params}");
        assert!(params.contains(r#""portNumber":["3306"]"#), "{params}");
        assert!(params.contains(r#""localPortNumber":["54321"]"#), "{params}");
    }

    #[test]
    fn ssmのパラメータはjsonとして壊れない() {
        // ホスト名に " が入っても、JSONとして読める形になる
        let args = build_args(&ssm(), r#"db".internal"#, 3306, 1).unwrap();
        let params = args.last().unwrap();
        let v: serde_json::Value =
            serde_json::from_str(params).expect("JSONとして読める");
        assert_eq!(v["host"][0], r#"db".internal"#);
        assert_eq!(v["portNumber"][0], "3306");
        // 余計なキーが混ざらない
        assert_eq!(v.as_object().unwrap().len(), 3);
    }

    #[test]
    fn ssmはリージョンとプロファイルを指定したときだけ足す() {
        let args = build_args(&ssm(), "db", 3306, 1).unwrap();
        assert!(!args.contains(&"--region".to_string()));
        assert!(!args.contains(&"--profile".to_string()));

        let mut cfg = ssm();
        cfg.region = "ap-northeast-1".into();
        cfg.profile = "prod".into();
        let args = build_args(&cfg, "db", 3306, 1).unwrap();
        let i = args.iter().position(|a| a == "--region").unwrap();
        assert_eq!(args[i + 1], "ap-northeast-1");
        let i = args.iter().position(|a| a == "--profile").unwrap();
        assert_eq!(args[i + 1], "prod");
    }

    #[test]
    fn ssmは接続先が空なら断る() {
        let mut cfg = ssm();
        cfg.target = "  ".into();
        assert!(build_args(&cfg, "db", 3306, 1).is_err());
        assert!(build_args(&ssm(), "  ", 3306, 1).is_err());
    }

    #[test]
    fn cloudsqlはローカルポートとインスタンスを渡す() {
        let args = build_args(&cloudsql(), "", 0, 6543).unwrap();
        let i = args.iter().position(|a| a == "--port").unwrap();
        assert_eq!(args[i + 1], "6543");
        assert_eq!(args.last().unwrap(), "my-proj:asia-northeast1:main");
        // 127.0.0.1 だけで待ち受ける (外から触れないように)
        let i = args.iter().position(|a| a == "--address").unwrap();
        assert_eq!(args[i + 1], "127.0.0.1");
    }

    #[test]
    fn cloudsqlは鍵ファイルとiam認証を指定したときだけ足す() {
        let args = build_args(&cloudsql(), "", 0, 1).unwrap();
        assert!(!args.contains(&"--credentials-file".to_string()));
        assert!(!args.contains(&"--auto-iam-authn".to_string()));

        let mut cfg = cloudsql();
        cfg.credentials_path = "/tmp/key.json".into();
        cfg.auto_iam = true;
        let args = build_args(&cfg, "", 0, 1).unwrap();
        let i = args.iter().position(|a| a == "--credentials-file").unwrap();
        assert_eq!(args[i + 1], "/tmp/key.json");
        assert!(args.contains(&"--auto-iam-authn".to_string()));
    }

    #[test]
    fn cloudsqlはインスタンス接続名の形を確かめる() {
        let mut cfg = cloudsql();
        cfg.instance = "main".into();
        assert!(build_args(&cfg, "", 0, 1).is_err());
        cfg.instance = String::new();
        assert!(build_args(&cfg, "", 0, 1).is_err());
    }

    #[test]
    fn 知らない種類は断る() {
        let mut cfg = ssm();
        cfg.kind = "telnet".into();
        assert!(build_args(&cfg, "db", 3306, 1).is_err());
    }
}
