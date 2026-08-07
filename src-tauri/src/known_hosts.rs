//! SSH踏み台のホスト鍵をTOFU (Trust On First Use) 方式で検証する。
//! 初回接続時に鍵のフィンガープリントを記録し、
//! 以後の接続で鍵が変わっていたら中間者攻撃の可能性があるため拒否する。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

/// known_hosts.json の保存先 (アプリ起動時にsetupで設定される)
static PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn init(path: PathBuf) {
    let _ = PATH.set(path);
}

fn load() -> HashMap<String, String> {
    let Some(path) = PATH.get() else {
        return HashMap::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(map: &HashMap<String, String>) -> Result<(), String> {
    let Some(path) = PATH.get() else {
        return Ok(());
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// ホスト鍵を検証する。
/// - 初回: 記録して受け入れる (TOFU)
/// - 一致: 受け入れる
/// - 不一致: 拒否理由の文字列を返す (呼び出し側で接続エラーにする)
pub fn verify(host: &str, port: u16, fingerprint: &str) -> Result<(), String> {
    let key = format!("{host}:{port}");
    let mut map = load();

    match map.get(&key) {
        None => {
            // 初回接続: 記録して信頼する
            map.insert(key, fingerprint.to_string());
            save(&map)?;
            Ok(())
        }
        Some(stored) if stored == fingerprint => Ok(()),
        Some(stored) => {
            let file = PATH
                .get()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "known_hosts.json".into());
            Err(format!(
                "SSHサーバー ({key}) のホスト鍵が前回接続時から変わっています。\n\
                 中間者攻撃の可能性があるため接続を中止しました。\n\
                 記録済み: {stored}\n\
                 今回:     {fingerprint}\n\
                 サーバーの再構築などで鍵が変わったことが確実な場合は、\n\
                 {file} から該当行を削除して再接続してください。"
            ))
        }
    }
}
