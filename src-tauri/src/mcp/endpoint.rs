//! 待受の在処を、別プロセスへ知らせるためのファイル。
//!
//! `--mcp-stdio` の中継 (`bridge`) は Tauri を初期化しないので、
//! `AppHandle` からポートを聞けない。
//! 待受を始めるときに書き、止めるときに消す小さなファイルで伝える。
//!
//! 設定フォルダの求め方を2通り持っているのは、
//! アプリ側 (`AppHandle` がある) と中継側 (無い) で経路が違うため。
//! 同じ場所を指すことはテストで確かめている

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 待受の在処を書くファイル名
pub const ENDPOINT_FILE: &str = "mcp_endpoint.json";

/// `tauri.conf.json` の identifier。
///
/// Tauri は設定フォルダの名前にこれを使う。
/// 中継側は Tauri を通らないので、同じ値をここにも持つ
/// (食い違うと、中継がトークンを見つけられない)
pub const APP_IDENTIFIER: &str = "jp.co.zefact.quelio";

/// 待受の在処
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    /// 待受ポート
    pub port: u16,
    /// 書いたアプリのプロセスID。
    ///
    /// 消し忘れたファイルを見分けるための手掛かり
    /// (残っていても、繋がらなければ中継はエラーで終わる)
    pub pid: u32,
}

impl Endpoint {
    pub fn url(&self) -> String {
        super::endpoint(self.port)
    }
}

/// 設定フォルダ (`AppHandle` を持たない側から求める)。
///
/// `json_store::config_path` と同じ場所になること
pub fn config_dir_without_tauri() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join(APP_IDENTIFIER))
}

/// 2つのパスが同じ場所を指しているか。
///
/// 末尾のスラッシュや `.` は無視する。
/// 実体があれば `canonicalize` で揃えるが、無くても文字列で比べられるようにする
/// (比較のためにフォルダを作りたくない)
fn same_dir(a: &std::path::Path, b: &std::path::Path) -> bool {
    let norm = |p: &std::path::Path| {
        // 実体があれば、リンクや相対の書き方を解いてから比べる
        std::fs::canonicalize(p).unwrap_or_else(|_| {
            // 無ければ、余分な区切りと `.` だけ落として比べる
            p.components().collect::<PathBuf>()
        })
    };
    norm(a) == norm(b)
}

/// アプリ側と中継側で、設定フォルダの求め方が一致しているかを確かめる。
///
/// アプリは Tauri に聞き、中継 (`--mcp-stdio`) は自分で組み立てる。
/// Tauri 側の規則が変わって静かにずれると、
/// 中継がトークンを見つけられず「Claude Desktop からだけ繋がらない」になる。
/// 起きたときに設定画面で気づけるよう、黙って進まない
pub fn check_same_dir(app: &tauri::AppHandle) -> Result<(), String> {
    let theirs = crate::json_store::config_path(app, ENDPOINT_FILE)?;
    let theirs = theirs
        .parent()
        .ok_or("設定フォルダを求められません")?
        .to_path_buf();
    let ours = config_dir_without_tauri().ok_or("設定フォルダを求められません")?;
    if same_dir(&theirs, &ours) {
        return Ok(());
    }
    Err(format!(
        "設定フォルダの求め方が食い違っています ({} と {})。\
         Claude Desktop 経由 (--mcp-stdio) の接続が使えない可能性があります",
        theirs.display(),
        ours.display()
    ))
}

/// そのプロセスが生きているか。
///
/// 通常終了やクラッシュで `mcp_endpoint.json` が残ることがある。
/// 残ったポートを別のアプリが掴んでいると、
/// 中継が「動いている」と思って繋ぎに行き、無駄に待たされる
#[cfg(unix)]
fn is_alive(pid: u32) -> bool {
    /*
     * 0以下の値は kill にとって特別な意味を持つ
     * (0 = 自分のプロセスグループ全部 / -1 = 送れるもの全部 /
     *  -1未満 = そのプロセスグループ全部)。
     * 壊れたファイルの数値をそのまま渡すと、
     * 「居ないのに居る」と答えてしまう。必ず正の値だけを見る
     */
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // シグナル0は「送らずに、送れるかだけ確かめる」
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    // EPERM は「居るが自分には触れない」= 生きている
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Windows では確かめずに生きている扱いにする。
///
/// プロセスの生存を見るには `windows-sys` が要るが、
/// そのためだけに依存を増やさない。
/// 残っていても、繋がらなければ中継は諦めるので実害は無い
/// (待ち時間は `bridge` 側のタイムアウトで頭打ちになる)
#[cfg(not(unix))]
fn is_alive(_pid: u32) -> bool {
    true
}

/// 待受の在処を書く (アプリ側)
pub fn write(app: &tauri::AppHandle, port: u16) -> Result<(), String> {
    let path = crate::json_store::config_path(app, ENDPOINT_FILE)?;
    let text = serde_json::to_string_pretty(&Endpoint {
        port,
        pid: std::process::id(),
    })
    .map_err(|e| format!("AI連携の待受情報を組み立てられません: {e}"))?;
    crate::json_store::write(&path, &text, "AI連携の待受情報")
}

/// 待受の在処を消す (アプリ側)。
///
/// 消せなくても止めるのは続ける (残っていても、繋がらなければ中継は諦める)
pub fn clear(app: &tauri::AppHandle) {
    if let Ok(path) = crate::json_store::config_path(app, ENDPOINT_FILE) {
        let _ = std::fs::remove_file(path);
    }
}

/// 待受の在処を読む (中継側)。
///
/// 無い・壊れている・ポートが0・**書いたプロセスがもういない** ときは
/// 「動いていない」とみなす
pub fn read_without_tauri() -> Option<Endpoint> {
    let path = config_dir_without_tauri()?.join(ENDPOINT_FILE);
    let text = std::fs::read_to_string(path).ok()?;
    let ep: Endpoint = serde_json::from_str(&text).ok()?;
    if ep.port == 0 || !is_alive(ep.pid) {
        return None;
    }
    Some(ep)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 設定フォルダにはidentifierが入る() {
        // Tauri 側と同じ場所を指すための取り決め。
        // ここが食い違うと、中継がトークンを見つけられない
        let dir = config_dir_without_tauri().expect("求められること");
        assert!(
            dir.ends_with(APP_IDENTIFIER),
            "{}",
            dir.display()
        );
    }

    #[test]
    fn 在処はjsonで往復できる() {
        let ep = Endpoint {
            port: 41777,
            pid: 1234,
        };
        let text = serde_json::to_string(&ep).expect("書けること");
        // 画面側と同じ camelCase で持つ
        assert!(text.contains("\"port\""), "{text}");
        assert!(text.contains("\"pid\""), "{text}");
        let back: Endpoint = serde_json::from_str(&text).expect("読めること");
        assert_eq!(back, ep);
    }

    #[test]
    fn 同じ場所なら一致とみなす() {
        let a = std::path::Path::new("/tmp/quelio-test/conf");
        // 末尾のスラッシュ・`.` の違いは同じ場所
        assert!(same_dir(a, std::path::Path::new("/tmp/quelio-test/conf/")));
        assert!(same_dir(a, std::path::Path::new("/tmp/quelio-test/./conf")));
        assert!(same_dir(a, a));
    }

    #[test]
    fn 違う場所は一致しない() {
        assert!(!same_dir(
            std::path::Path::new("/tmp/quelio-test/conf"),
            std::path::Path::new("/tmp/quelio-test/other")
        ));
        // 途中が違うものも別扱い
        assert!(!same_dir(
            std::path::Path::new("/a/jp.co.zefact.quelio"),
            std::path::Path::new("/b/jp.co.zefact.quelio")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn 自分のプロセスは生きている() {
        assert!(is_alive(std::process::id()));
    }

    #[cfg(unix)]
    #[test]
    fn 居ないプロセスは死んでいる() {
        // 残った待受情報を見分けるための判定
        assert!(!is_alive(u32::MAX));
    }

    #[cfg(unix)]
    #[test]
    fn 特別な意味を持つ値は生きている扱いにしない() {
        /*
         * kill にとって 0 や負の値は「まとめて送る」指定。
         * そのまま渡すと「居る」と答えてしまうので、
         * 壊れたファイルの数値でも必ず死んでいる扱いにする
         */
        assert!(!is_alive(0));
        // i32 として -1 になる値 (u32::MAX) も同じ
        assert!(!is_alive(u32::MAX));
        // i32 に収まらない大きな値
        assert!(!is_alive(u32::MAX - 1));
    }

    #[test]
    fn 在処からurlを作れる() {
        let ep = Endpoint {
            port: 41777,
            pid: 1,
        };
        assert_eq!(ep.url(), "http://127.0.0.1:41777/mcp");
    }
}
