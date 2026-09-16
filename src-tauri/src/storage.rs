use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::crypto;
use crate::models::{ConnectionProfile, ConnectionStore};

/// 旧アプリ名(DB Tool)時代の識別子
const LEGACY_IDENTIFIER: &str = "com.root.db_tool";

/// 接続プロファイルの保存先 (アプリ設定ディレクトリ/connections.json)
fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定ディレクトリを取得できません: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("設定ディレクトリを作成できません: {e}"))?;
    let path = dir.join("connections.json");

    // Quelio改名前(識別子変更前)の設定が残っていれば初回に引き継ぐ
    if !path.exists() {
        if let Some(parent) = dir.parent() {
            let legacy = parent.join(LEGACY_IDENTIFIER).join("connections.json");
            if legacy.exists() {
                let _ = fs::copy(&legacy, &path);
            }
        }
    }

    Ok(path)
}

/// 秘匿すべき値が旧形式(平文)で残っているか
fn has_plaintext_secret(store: &ConnectionStore) -> bool {
    store.connections.iter().any(|c| {
        let pw_plain = !c.password.is_empty() && !c.password.starts_with(crypto::ENC_PREFIX);
        let pp_plain = c
            .ssh
            .as_ref()
            .and_then(|s| s.passphrase.as_ref())
            .is_some_and(|p| !p.is_empty() && !p.starts_with(crypto::ENC_PREFIX));
        pw_plain || pp_plain
    })
}

/// ファイルを読んで形にするところまで (復号も自動移行もしない)。
///
/// `load` と `load_without_secrets` の共通部分。
/// 読み方を1か所にしておかないと、旧形式の扱いが片方だけ直って食い違う
fn read_store(app: &AppHandle) -> Result<ConnectionStore, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(ConnectionStore::default());
    }
    let text =
        fs::read_to_string(&path).map_err(|e| format!("設定ファイルを読み込めません: {e}"))?;
    parse_store(&text)
}

/// 設定ファイルの中身を形にする (ファイルにも鍵にも触らない)。
///
/// ここを分けてあるのは、旧形式の読み替えを試せるようにするため。
/// 秘匿値は **書いてあるまま** (暗号文のまま) 入る
fn parse_store(text: &str) -> Result<ConnectionStore, String> {
    // 旧形式 (プロファイルの配列だけ) → 新形式へ
    if text.trim_start().starts_with('[') {
        let connections: Vec<ConnectionProfile> = serde_json::from_str(text)
            .map_err(|e| format!("設定ファイルの形式が不正です: {e}"))?;
        return Ok(ConnectionStore {
            folders: Vec::new(),
            connections,
            ..Default::default()
        });
    }
    serde_json::from_str(text).map_err(|e| format!("設定ファイルの形式が不正です: {e}"))
}

/// 秘匿値を **復号せずに** 読み込む。
///
/// 名前・種別・環境といった「秘密でないところ」しか要らない用途 (AI連携の一覧など) 向け。
///
/// `load` はマスターキーを取り出す (macOS/Windows ではキーチェーンに触る) うえ、
/// 平文が残っていれば保存し直しまで行う。
/// 一覧を作るだけのために、全接続のパスワードを平文でメモリへ載せたくない。
/// 返ってくる `password` / `passphrase` は暗号文のままなので、繋ぐのには使えない
pub fn load_without_secrets(app: &AppHandle) -> Result<ConnectionStore, String> {
    read_store(app)
}

/// 保存されている接続先一式を読み込む (パスワードは復号済みで返す)。
/// 旧形式(プロファイルの配列のみ / 平文パスワード)は自動で移行する。
pub fn load(app: &AppHandle) -> Result<ConnectionStore, String> {
    let mut store = read_store(app)?;

    // 平文が残っていれば暗号化して保存し直す (自動移行)
    let migrate = has_plaintext_secret(&store);
    if migrate {
        save(app, &store)?;
    }

    // 復号して返す。
    // 復号できなかった値は暗号文のまま残し、目印を立てる
    // (空文字にすると、次の保存でそのまま上書きされ保存済みパスワードが消えるため)
    let keys = crypto::master_keys(app)?;
    for c in &mut store.connections {
        let mut locked = false;
        match keys.decrypt(&c.password) {
            Some(plain) => c.password = plain,
            None => locked = true,
        }
        if let Some(ssh) = &mut c.ssh {
            if let Some(p) = &ssh.passphrase {
                match keys.decrypt(p) {
                    Some(plain) => ssh.passphrase = Some(plain),
                    None => locked = true,
                }
            }
        }
        c.password_locked = locked;
    }
    Ok(store)
}

/// 画面へ渡す前に秘匿値を伏せる。
///
/// パスワードとパスフレーズを使うのはバックエンドだけなので、
/// 一覧を取るたびに全接続分を画面へ送る必要はない。
/// 「保存済みである」ことだけを目印で伝える
pub fn mask_secrets(store: &mut ConnectionStore) {
    for c in &mut store.connections {
        c.password_saved = !c.password.is_empty();
        c.password = String::new();
        if let Some(ssh) = &mut c.ssh {
            c.passphrase_saved = ssh.passphrase.as_deref().is_some_and(|p| !p.is_empty());
            ssh.passphrase = None;
        }
    }
}

/// 伏せた秘匿値を、保存済みの内容から戻す。
///
/// 画面は「変更していない」ものを目印付きで返してくるので、
/// そのときだけ保存済みの値を補う (入力し直した値はそのまま使う)
pub fn restore_secrets(
    app: &AppHandle,
    profile: &mut ConnectionProfile,
) -> Result<(), String> {
    if !profile.password_saved && !profile.passphrase_saved {
        return Ok(());
    }
    if profile.id.is_empty() {
        // 新規の接続先には、補える保存済みの値が無い
        profile.password_saved = false;
        profile.passphrase_saved = false;
        return Ok(());
    }
    let store = load(app)?;
    let Some(saved) = store.connections.iter().find(|c| c.id == profile.id) else {
        profile.password_saved = false;
        profile.passphrase_saved = false;
        return Ok(());
    };
    if profile.password_saved {
        profile.password = saved.password.clone();
        // 保存済みの値が復号できていなければ、その状態も引き継ぐ
        profile.password_locked = profile.password_locked || saved.password_locked;
    }
    if profile.passphrase_saved {
        if let Some(ssh) = &mut profile.ssh {
            ssh.passphrase = saved.ssh.as_ref().and_then(|s| s.passphrase.clone());
        }
        profile.password_locked = profile.password_locked || saved.password_locked;
    }
    Ok(())
}

/// 接続先一式を保存する (パスワード・SSHパスフレーズは暗号化して書き込む)
pub fn save(app: &AppHandle, store: &ConnectionStore) -> Result<(), String> {
    let keys = crypto::master_keys(app)?;
    let key = keys.primary();
    let mut enc = store.clone();
    for c in &mut enc.connections {
        // 復号できなかった値は暗号文のまま渡ってくる。
        // encryptは暗号文をそのまま返すので、元の値が保たれる
        c.password = crypto::encrypt(key, &c.password)?;
        if let Some(ssh) = &mut c.ssh {
            if let Some(p) = &ssh.passphrase {
                ssh.passphrase = Some(crypto::encrypt(key, p)?);
            }
        }
        // 実行時の目印なので保存はしない
        c.password_locked = false;
        c.password_saved = false;
        c.passphrase_saved = false;
    }
    let path = store_path(app)?;
    let text = serde_json::to_string_pretty(&enc)
        .map_err(|e| format!("設定のシリアライズに失敗: {e}"))?;
    // 直前の内容を .bak に残しつつ、一時ファイル経由で置き換える
    crate::json_store::write_with_backup(&path, &text, "設定ファイル")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 暗号文つきの接続先 (新形式)
    fn text() -> String {
        format!(
            r#"{{"connections":[{{
                "id":"a","name":"本番参照","dbType":"mysql",
                "host":"db.example.com","port":3306,"user":"app",
                "password":"{p}ZW5jcnlwdGVk",
                "aiAccess":"read",
                "ssh":{{"enabled":true,"host":"bastion","port":22,"user":"ops",
                       "keyPath":"/home/me/.ssh/id_ed25519",
                       "passphrase":"{p}cGFzcw=="}}
            }}]}}"#,
            p = crypto::ENC_PREFIX
        )
    }

    #[test]
    fn 読むだけでは復号しない() {
        // 鍵に触らないことの裏付け: 暗号文がそのまま残っていれば、復号は走っていない
        // (キーチェーンの無い環境でもこの関数が通ることも同時に確かめている)
        let store = parse_store(&text()).expect("読めること");
        let c = &store.connections[0];
        assert!(c.password.starts_with(crypto::ENC_PREFIX), "{}", c.password);
        let pp = c.ssh.as_ref().and_then(|s| s.passphrase.as_deref()).unwrap();
        assert!(pp.starts_with(crypto::ENC_PREFIX), "{pp}");
    }

    #[test]
    fn 秘密でないところはそのまま読める() {
        let store = parse_store(&text()).expect("読めること");
        let c = &store.connections[0];
        assert_eq!(c.name, "本番参照");
        assert_eq!(c.ai_access, crate::models::AiAccess::Read);
    }

    #[test]
    fn 旧形式_配列だけ_も読める() {
        let old = r#"[{"id":"a","name":"古い","dbType":"sqlite","host":"","port":0,"user":""}]"#;
        let store = parse_store(old).expect("読めること");
        assert_eq!(store.connections.len(), 1);
        assert_eq!(store.connections[0].name, "古い");
        assert!(store.folders.is_empty());
    }

    #[test]
    fn ai連携の指定が無ければ公開しないになる() {
        let text = r#"{"connections":[{"id":"a","name":"x","dbType":"mysql","host":"h","port":3306,"user":"u"}]}"#;
        let store = parse_store(text).expect("読めること");
        assert_eq!(
            store.connections[0].ai_access,
            crate::models::AiAccess::None
        );
    }
}
