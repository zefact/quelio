//! SSH踏み台のホスト鍵をTOFU (Trust On First Use) 方式で検証する。
//! 初回接続時に鍵のフィンガープリントを記録し、
//! 以後の接続で鍵が変わっていたら中間者攻撃の可能性があるため拒否する。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// known_hosts.json の保存先 (アプリ起動時にsetupで設定される)
static PATH: OnceLock<PathBuf> = OnceLock::new();

/// 読み込み→書き込みを直列化する
/// (複数タブから同時に初回接続すると、記録が混ざって壊れるため)
static LOCK: Mutex<()> = Mutex::new(());

pub fn init(path: PathBuf) {
    let _ = PATH.set(path);
}

/// 記録済みのホスト鍵を読み込む。
/// 保存先が未設定・ファイルが壊れている場合はエラーにする。
/// (黙って空を返すと「初回接続」扱いになり、鍵の検証自体が無効になるため)
fn load() -> Result<HashMap<String, String>, String> {
    let Some(path) = PATH.get() else {
        return Err(
            "SSHホスト鍵の記録先を初期化できていないため、接続を中止しました".to_string(),
        );
    };
    Ok(crate::json_store::read(path, "SSHホスト鍵の記録")?.unwrap_or_default())
}

fn save(map: &HashMap<String, String>) -> Result<(), String> {
    let Some(path) = PATH.get() else {
        return Ok(());
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    crate::json_store::write(path, &json, "SSHホスト鍵の記録")
}

/// 初めて見るホスト鍵に出会ったことを表すしるし (エラーの1行目に入れる)。
///
/// 画面はこの行を見て、フィンガープリントの確認ダイアログを出す。
/// 形式: `SSH_HOST_UNKNOWN\tホスト\tポート\tフィンガープリント`
pub const UNKNOWN_HOST_MARK: &str = "SSH_HOST_UNKNOWN";

/// 記録と違うホスト鍵に出会ったことを表すしるし (エラーの1行目に入れる)。
///
/// 画面はこの行を見て、記録済みと今回の値を並べた確認ダイアログを出す。
/// 形式: `SSH_HOST_CHANGED\tホスト\tポート\t今回のフィンガープリント\t記録済みのフィンガープリント`
pub const CHANGED_HOST_MARK: &str = "SSH_HOST_CHANGED";

/// 利用者が確認したホスト鍵を記録する (画面の確認ダイアログから呼ぶ)。
///
/// `replacing` は、確認ダイアログで「記録済み」として見せた値 (初回接続なら None)。
/// 記録がその値のままのときだけ書き換える。ダイアログを出している間に
/// 別のタブで記録が変わっていたら、見せていない鍵を黙って上書きしないよう断る
pub fn trust(
    host: &str,
    port: u16,
    fingerprint: &str,
    replacing: Option<&str>,
) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = load()?;
    let key = host_key(host, port);
    if !can_record(&map, &key, fingerprint, replacing) {
        return Err(format!(
            "SSHサーバー ({key}) のホスト鍵の記録が、確認している間に変わりました。\n\
             もう一度接続して、表示される値を確かめ直してください。"
        ));
    }
    map.insert(key, fingerprint.to_string());
    save(&map)
}

/// 記録の名前 (ホスト:ポート)
fn host_key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

/// 確認された鍵を記録してよいか。
/// 今の記録が、確認ダイアログで見せた状態 (記録なし / 見せた値) のままか、
/// すでに同じ鍵が記録されているときだけ通す
fn can_record(
    map: &HashMap<String, String>,
    key: &str,
    fingerprint: &str,
    replacing: Option<&str>,
) -> bool {
    match map.get(key) {
        Some(now) if now == fingerprint => true,
        now => now.map(String::as_str) == replacing,
    }
}

/// 記録と照らし合わせた結果
#[derive(Debug, PartialEq)]
enum Verdict<'a> {
    /// 記録が無い (初めての接続)
    Unknown,
    /// 記録と同じ
    Match,
    /// 記録と違う (中身は記録済みの値)
    Changed(&'a str),
}

fn judge<'a>(map: &'a HashMap<String, String>, key: &str, fingerprint: &str) -> Verdict<'a> {
    match map.get(key) {
        None => Verdict::Unknown,
        Some(stored) if stored == fingerprint => Verdict::Match,
        Some(stored) => Verdict::Changed(stored),
    }
}

/// ホスト鍵を検証する。
/// - 初回: 記録が無いので中止し、確認をうながす (利用者が確認したら trust で記録する)
/// - 一致: 受け入れる
/// - 不一致: 中止し、記録済みと今回の値を見せて確認をうながす
///   (鍵が変わったことが確実なら、利用者が trust で記録し直す)
pub fn verify(host: &str, port: u16, fingerprint: &str) -> Result<(), String> {
    // 他のスレッドがパニックしていても、記録の読み書き自体は続けられる
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let key = host_key(host, port);
    let map = load()?;

    match judge(&map, &key, fingerprint) {
        Verdict::Unknown => {
            /*
             * 初回接続。
             * 黙って信頼すると、最初の1回が中間者だった場合に気づけないので、
             * フィンガープリントを見せて確認してもらう
             */
            Err(format!(
                "{UNKNOWN_HOST_MARK}\t{host}\t{port}\t{fingerprint}\n\
                 SSHサーバー ({key}) へは初めての接続です。\n\
                 ホスト鍵のフィンガープリントが、管理者から知らされている値と\n\
                 同じかどうかを確認してください。\n\
                 {fingerprint}"
            ))
        }
        Verdict::Match => Ok(()),
        Verdict::Changed(stored) => {
            let file = PATH
                .get()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "known_hosts.json".into());
            /*
             * 1行目のしるしは画面が読み取り、確認ダイアログを出す。
             * ダイアログが出ない場所 (しるしを読まない画面) 向けに、
             * 本文には記録のある場所も書いておく
             */
            Err(format!(
                "{CHANGED_HOST_MARK}\t{host}\t{port}\t{fingerprint}\t{stored}\n\
                 SSHサーバー ({key}) のホスト鍵が前回接続時から変わっています。\n\
                 中間者攻撃の可能性があるため接続を中止しました。\n\
                 記録済み: {stored}\n\
                 今回:     {fingerprint}\n\
                 サーバーの再構築などで鍵が変わったことが確実な場合は、\n\
                 接続画面からもう一度接続すると、新しい鍵を記録し直せます。\n\
                 (記録の場所: {file} の \"{key}\" の項目)"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn 記録と照らし合わせる() {
        let m = map(&[("h:22", "SHA256:old")]);
        assert_eq!(judge(&m, "h:22", "SHA256:old"), Verdict::Match);
        assert_eq!(judge(&m, "h:22", "SHA256:new"), Verdict::Changed("SHA256:old"));
        assert_eq!(judge(&m, "other:22", "SHA256:old"), Verdict::Unknown);
    }

    #[test]
    fn 初回の鍵は記録が無いときだけ記録できる() {
        assert!(can_record(&map(&[]), "h:22", "SHA256:new", None));
        // 確認している間に別の鍵が記録されていたら断る
        assert!(!can_record(&map(&[("h:22", "SHA256:x")]), "h:22", "SHA256:new", None));
    }

    #[test]
    fn 変わった鍵は見せた記録のままのときだけ記録し直せる() {
        let m = map(&[("h:22", "SHA256:old")]);
        assert!(can_record(&m, "h:22", "SHA256:new", Some("SHA256:old")));
        // 見せた値と今の記録が違う (確認中に書き換わった)
        assert!(!can_record(&m, "h:22", "SHA256:new", Some("SHA256:other")));
        // 記録が消えていたら、見せた状態と違うので断る
        assert!(!can_record(&map(&[]), "h:22", "SHA256:new", Some("SHA256:old")));
    }

    #[test]
    fn 同じ鍵がすでに記録されていれば通す() {
        // 2つのタブで同時に確認したときなど
        let m = map(&[("h:22", "SHA256:new")]);
        assert!(can_record(&m, "h:22", "SHA256:new", None));
        assert!(can_record(&m, "h:22", "SHA256:new", Some("SHA256:old")));
    }
}
