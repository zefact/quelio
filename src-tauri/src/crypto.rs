use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use tauri::{AppHandle, Manager};

/// 保存パスワードの暗号化。
/// AES-256-GCMで暗号化し、マスターキーはOSのキーチェーン
/// (macOS: Keychain / Windows: 資格情報マネージャー) に保存する。
/// キーチェーンが使えない環境では設定ディレクトリ内の鍵ファイルにフォールバックする。

/// 暗号化済み文字列の接頭辞 (これが無い値は旧形式=平文とみなす)
pub const ENC_PREFIX: &str = "enc:v1:";

const KEYCHAIN_SERVICE: &str = "jp.co.zefact.quelio";
const KEYCHAIN_ACCOUNT: &str = "master-key";

/// キーチェーンからマスターキーを取得 (無ければ生成して保存)
fn key_from_keychain() -> Result<Vec<u8>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("キーチェーンを開けません: {e}"))?;
    match entry.get_password() {
        Ok(b64) => B64
            .decode(b64)
            .map_err(|e| format!("マスターキーの形式が不正です: {e}")),
        Err(keyring::Error::NoEntry) => {
            let key = Aes256Gcm::generate_key(OsRng);
            entry
                .set_password(&B64.encode(key))
                .map_err(|e| format!("キーチェーンへ保存できません: {e}"))?;
            Ok(key.to_vec())
        }
        Err(e) => Err(format!("キーチェーンから読み込めません: {e}")),
    }
}

/// フォールバック: 設定ディレクトリの鍵ファイル (所有者のみ読める権限)
fn key_from_file(app: &AppHandle) -> Result<Vec<u8>, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定ディレクトリを取得できません: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("設定ディレクトリを作成できません: {e}"))?;
    let path = dir.join(".master_key");
    if path.exists() {
        let b64 = std::fs::read_to_string(&path)
            .map_err(|e| format!("鍵ファイルを読み込めません: {e}"))?;
        return B64
            .decode(b64.trim())
            .map_err(|e| format!("鍵ファイルの形式が不正です: {e}"));
    }
    let key = Aes256Gcm::generate_key(OsRng);
    std::fs::write(&path, B64.encode(key)).map_err(|e| format!("鍵ファイルを保存できません: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(key.to_vec())
}

/// マスターキーを取得する (キーチェーン優先)
pub fn master_key(app: &AppHandle) -> Result<[u8; 32], String> {
    let bytes = key_from_keychain().or_else(|_| key_from_file(app))?;
    bytes
        .try_into()
        .map_err(|_| "マスターキーの長さが不正です".to_string())
}

/// 平文を暗号化して "enc:v1:..." 形式で返す (空文字はそのまま)
pub fn encrypt(key: &[u8; 32], plain: &str) -> String {
    if plain.is_empty() || plain.starts_with(ENC_PREFIX) {
        return plain.to_string();
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    match cipher.encrypt(&nonce, plain.as_bytes()) {
        Ok(ct) => {
            let mut out = nonce.to_vec();
            out.extend(ct);
            format!("{ENC_PREFIX}{}", B64.encode(out))
        }
        // 暗号化に失敗した場合は保存しない方が安全
        Err(_) => String::new(),
    }
}

/// 保存値を復号する。旧形式(平文)はそのまま返し、
/// 復号できない場合(鍵が変わった等)は空文字を返す
pub fn decrypt(key: &[u8; 32], stored: &str) -> String {
    let Some(b64) = stored.strip_prefix(ENC_PREFIX) else {
        return stored.to_string();
    };
    let Ok(data) = B64.decode(b64) else {
        return String::new();
    };
    if data.len() < 12 {
        return String::new();
    }
    let (nonce, ct) = data.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    match cipher.decrypt(Nonce::from_slice(nonce), ct) {
        Ok(plain) => String::from_utf8(plain).unwrap_or_default(),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let key = [7u8; 32];
        let enc = encrypt(&key, "p@ss日本語");
        assert!(enc.starts_with(ENC_PREFIX));
        assert_eq!(decrypt(&key, &enc), "p@ss日本語");
        // 平文(旧形式)はそのまま
        assert_eq!(decrypt(&key, "plain"), "plain");
        // 空文字はそのまま
        assert_eq!(encrypt(&key, ""), "");
        // 別の鍵では復号できず空になる
        let other = [9u8; 32];
        assert_eq!(decrypt(&other, &enc), "");
        // 二重暗号化はしない
        assert_eq!(encrypt(&key, &enc), enc);
    }
}
