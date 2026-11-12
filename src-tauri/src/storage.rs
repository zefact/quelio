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
    // 鍵ファイルの鍵でしか開けなかった値があるか (キーチェーンの鍵で暗号化し直す)
    let mut rekey = false;
    for c in &mut store.connections {
        let mut locked = false;
        match keys.decrypt_noting_fallback(&c.password) {
            Some((plain, by_file)) => {
                c.password = plain;
                rekey |= by_file;
            }
            None => locked = true,
        }
        if let Some(ssh) = &mut c.ssh {
            if let Some(p) = &ssh.passphrase {
                match keys.decrypt_noting_fallback(p) {
                    Some((plain, by_file)) => {
                        ssh.passphrase = Some(plain);
                        rekey |= by_file;
                    }
                    None => locked = true,
                }
            }
        }
        c.password_locked = locked;
    }
    if keys.has_fallback() {
        // 片付けられなくても読み込みは続ける (鍵ファイルが残るだけで、値は開ける)
        let _ = retire_key_file(app, &store, rekey);
    }
    Ok(store)
}

/**
 * キーチェーンが使えるようになった後に、鍵ファイルを片付ける。
 *
 * キーチェーンが読めなかった間は、鍵ファイルの鍵で暗号化して保存している。
 * 鍵ファイルを残し続けると、暗号文と鍵が同じフォルダに並んだままになるので、
 * 1. 鍵ファイルの鍵でしか開けない値を、キーチェーンの鍵で暗号化し直して保存し
 * 2. 保存した内容を読み直して、鍵ファイルの鍵でしか開けない値が無いことを確かめてから
 * 3. 鍵ファイルを消す
 *
 * キーチェーンが読むたびに違う鍵を返す (保存されない) 環境では何もしない。
 * なお直前の `connections.json.bak` は鍵ファイルの鍵のままなので、
 * 消した後は `.bak` からは戻せなくなる (次の保存で入れ替わる控えなので許容する)
 */
fn retire_key_file(app: &AppHandle, store: &ConnectionStore, rekey: bool) -> Result<(), String> {
    if !crypto::keychain_is_stable() {
        return Ok(());
    }
    if rekey {
        save(app, store)?;
    }
    let saved = read_store(app)?;
    let keys = crypto::master_keys(app)?;
    if !still_needs_fallback(&keys, &saved) {
        crypto::remove_key_file(app)?;
    }
    Ok(())
}

/// 保存済みの値 (暗号文のまま) に、鍵ファイルの鍵でしか開けないものが残っているか
fn still_needs_fallback(keys: &crypto::MasterKeys, saved: &ConnectionStore) -> bool {
    saved.connections.iter().any(|c| {
        keys.only_fallback_opens(&c.password)
            || c
                .ssh
                .as_ref()
                .and_then(|s| s.passphrase.as_deref())
                .is_some_and(|p| keys.only_fallback_opens(p))
    })
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

/// 画面に見せる保存済みの秘匿値の種類
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretKind {
    /// DBのパスワード
    Password,
    /// SSHの秘密鍵のパスフレーズ
    Passphrase,
}

/**
 * 保存済みの秘匿値を1つだけ取り出す (画面の「表示」ボタンから、確認のあとで呼ぶ)。
 *
 * 一覧や保存の戻り値では、これまでどおり秘匿値を伏せたまま渡す。
 * ここは、利用者が1つの接続先の1つの値を見ると決めたときだけ通る口
 */
pub fn saved_secret(app: &AppHandle, id: &str, kind: SecretKind) -> Result<String, String> {
    pick_secret(&load(app)?, id, kind)
}

/// 復号済みの一式から、指定の秘匿値を取り出す
fn pick_secret(store: &ConnectionStore, id: &str, kind: SecretKind) -> Result<String, String> {
    let c = store
        .connections
        .iter()
        .find(|c| c.id == id)
        .ok_or("接続先が見つかりません")?;
    // 復号できなかった値は暗号文のまま入っているので、見せない
    if c.password_locked {
        return Err("保存されたパスワードを復号できませんでした。入力し直して保存してください".into());
    }
    let value = match kind {
        SecretKind::Password => c.password.clone(),
        SecretKind::Passphrase => c
            .ssh
            .as_ref()
            .and_then(|s| s.passphrase.clone())
            .unwrap_or_default(),
    };
    if value.is_empty() {
        return Err("保存されていません".into());
    }
    Ok(value)
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

    #[test]
    fn 鍵ファイルの鍵でしか開けない値が残っていれば片付けない() {
        let (keychain, file) = ([1u8; 32], [2u8; 32]);
        let keys = crypto::MasterKeys::for_test(keychain, vec![file]);
        let store = |pw: String, pp: Option<String>| -> ConnectionStore {
            let mut v = serde_json::json!({"connections": [{
                "id": "a", "name": "n", "dbType": "mysql",
                "host": "h", "port": 3306, "user": "u", "password": pw
            }]});
            if let Some(pp) = pp {
                v["connections"][0]["ssh"] = serde_json::json!({
                    "enabled": true, "host": "b", "port": 22, "user": "o",
                    "keyPath": "", "passphrase": pp
                });
            }
            serde_json::from_value(v).unwrap()
        };
        let by_keychain = || crypto::encrypt(&keychain, "pw").unwrap();
        let by_file = || crypto::encrypt(&file, "pw").unwrap();

        // すべてキーチェーンの鍵で開ける → 片付けてよい
        assert!(!still_needs_fallback(&keys, &store(by_keychain(), Some(by_keychain()))));
        // パスワードかパスフレーズのどちらかが鍵ファイルの鍵のまま → 残す
        assert!(still_needs_fallback(&keys, &store(by_file(), None)));
        assert!(still_needs_fallback(&keys, &store(by_keychain(), Some(by_file()))));
        // どの鍵でも開けない値は、鍵ファイルを残しても開けないので数えない
        let lost = crypto::encrypt(&[3u8; 32], "pw").unwrap();
        assert!(!still_needs_fallback(&keys, &store(lost, None)));
    }

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
    fn 保存済みの秘匿値を1つ取り出す() {
        let mut store = parse_store(&text()).expect("読めること");
        // load と同じく、復号済みの状態にしておく
        store.connections[0].password = "pw".into();
        store.connections[0].ssh.as_mut().unwrap().passphrase = Some("pp".into());
        assert_eq!(pick_secret(&store, "a", SecretKind::Password).unwrap(), "pw");
        assert_eq!(pick_secret(&store, "a", SecretKind::Passphrase).unwrap(), "pp");
        assert!(pick_secret(&store, "none", SecretKind::Password).is_err());
    }

    #[test]
    fn 復号できなかった値と空の値は見せない() {
        let mut store = parse_store(&text()).expect("読めること");
        store.connections[0].password_locked = true;
        // 暗号文のまま入っていても返さない
        assert!(pick_secret(&store, "a", SecretKind::Password).is_err());

        store.connections[0].password_locked = false;
        store.connections[0].password = String::new();
        store.connections[0].ssh = None;
        assert!(pick_secret(&store, "a", SecretKind::Password).is_err());
        assert!(pick_secret(&store, "a", SecretKind::Passphrase).is_err());
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
