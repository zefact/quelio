use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use tauri::{AppHandle, Manager};

/*
 * 保存パスワードの暗号化。
 *
 * AES-256-GCMで暗号化し、マスターキーはOSのキーチェーン
 * (macOS: Keychain / Windows: 資格情報マネージャー) に保存する。
 * キーチェーンが使えない環境では設定ディレクトリ内の鍵ファイルを使う。
 *
 * 注意: キーチェーンは「一時的に」読めないことがある
 * (ロック中・アクセスを拒否された・サービス未起動など)。
 * そのときに鍵ファイルへ勝手に切り替えると、
 * キーチェーンの鍵で保存した値が読めなくなってしまう。
 * そこで復号は「持っている鍵を順に試す」形にし、
 * 鍵ファイルはキーチェーンが使えないときにだけ作る
 */

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

/// 鍵ファイルの置き場所
fn key_file_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定ディレクトリを取得できません: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("設定ディレクトリを作成できません: {e}"))?;
    Ok(dir.join(".master_key"))
}

/// 鍵ファイルを読む。
///
/// 「無い」(Ok(None)) と「あるのに読めない」(Err) を分ける。
/// 一緒にすると、読めないだけの鍵ファイルを作り直して
/// 保存済みのパスワードを永久に開けなくしてしまう
fn read_key_file(app: &AppHandle) -> Result<Option<Vec<u8>>, String> {
    let path = key_file_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(b64) => B64
            .decode(b64.trim())
            .map(Some)
            .map_err(|e| format!("鍵ファイルの形式が不正です: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("鍵ファイルを読み込めません: {e}")),
    }
}

/// 鍵ファイルを作る (キーチェーンが使えず、鍵ファイルも無いときだけ)。
///
/// 既にあれば失敗させる (上書きすると元の鍵が失われるため)。
/// 作成時からパーミッションを絞り、一瞬でも他人に読める時間を作らない
fn create_key_file(app: &AppHandle) -> Result<Vec<u8>, String> {
    use std::io::Write;
    let path = key_file_path(app)?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(&path)
        .map_err(|e| format!("鍵ファイルを作成できません: {e}"))?;
    let key = Aes256Gcm::generate_key(OsRng);
    file.write_all(B64.encode(key).as_bytes())
        .map_err(|e| format!("鍵ファイルを保存できません: {e}"))?;
    Ok(key.to_vec())
}

/// 持っているマスターキー。
/// 保存には `primary` を使い、復号は primary → fallbacks の順に試す
pub struct MasterKeys {
    primary: [u8; 32],
    /// 過去に使っていた鍵 (キーチェーンが読めなかった間に作った鍵など)
    fallbacks: Vec<[u8; 32]>,
}

fn to_key(bytes: Vec<u8>) -> Result<[u8; 32], String> {
    bytes
        .try_into()
        .map_err(|_| "マスターキーの長さが不正です".to_string())
}

/// マスターキーを揃える (キーチェーン優先)
pub fn master_keys(app: &AppHandle) -> Result<MasterKeys, String> {
    match key_from_keychain() {
        Ok(bytes) => Ok(MasterKeys {
            primary: to_key(bytes)?,
            /*
             * 鍵ファイルが残っていれば復号用に持っておく。
             * 以前キーチェーンが読めずに鍵ファイルで保存した値を、
             * 読めるようになった後も開けるようにするため。
             * ここは「読めたら使う」だけなので、失敗しても先へ進む
             */
            fallbacks: read_key_file(app)
                .ok()
                .flatten()
                .and_then(|b| to_key(b).ok())
                .into_iter()
                .collect(),
        }),
        Err(keychain_err) => {
            // キーチェーンが使えない環境・状態。鍵ファイルで代用する
            let bytes = match read_key_file(app) {
                Ok(Some(b)) => b,
                // 鍵ファイルも無ければ作るしかない
                // (キーチェーンが戻れば、この鍵はfallbackとして残る)
                Ok(None) => create_key_file(app).map_err(|e| format!("{keychain_err} / {e}"))?,
                // 「あるのに読めない」ときは作り直さない。
                // 作り直すと、その鍵で保存した値が二度と開けなくなる
                Err(file_err) => return Err(format!("{keychain_err} / {file_err}")),
            };
            Ok(MasterKeys {
                primary: to_key(bytes)?,
                fallbacks: Vec::new(),
            })
        }
    }
}

impl MasterKeys {
    /// 保存に使う鍵
    pub fn primary(&self) -> &[u8; 32] {
        &self.primary
    }

    /// 持っている鍵を順に試して復号する
    pub fn decrypt(&self, stored: &str) -> Option<String> {
        if let Some(plain) = decrypt(&self.primary, stored) {
            return Some(plain);
        }
        self.fallbacks.iter().find_map(|k| decrypt(k, stored))
    }
}

/// 保存済みの暗号文の形をしているか。
///
/// 「`enc:v1:` で始まる」だけで判断すると、その文字列を実際のパスワードに
/// 使っている場合に、平文のまま保存してしまう。
/// 中身まで見て、暗号文として辻褄が合うものだけを暗号化済みとみなす
pub fn looks_encrypted(stored: &str) -> bool {
    let Some(body) = stored.strip_prefix(ENC_PREFIX) else {
        return false;
    };
    match B64.decode(body) {
        // nonce(12バイト) + 認証タグ(16バイト) より短いものは暗号文ではない
        Ok(bytes) => bytes.len() >= 12 + 16,
        Err(_) => false,
    }
}

/// 平文を暗号化して "enc:v1:..." 形式で返す (空文字・暗号化済みはそのまま)
pub fn encrypt(key: &[u8; 32], plain: &str) -> Result<String, String> {
    if plain.is_empty() || looks_encrypted(plain) {
        return Ok(plain.to_string());
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    match cipher.encrypt(&nonce, plain.as_bytes()) {
        Ok(ct) => {
            let mut out = nonce.to_vec();
            out.extend(ct);
            Ok(format!("{ENC_PREFIX}{}", B64.encode(out)))
        }
        // 空文字を返すと保存済みの値を失うため、保存自体を中止する
        Err(e) => Err(format!("パスワードを暗号化できませんでした: {e}")),
    }
}

/// 保存値を復号する。旧形式(平文)はそのまま返す。
/// 復号できない場合 (マスターキーが変わった等) は None を返す。
/// 呼び出し側は None のとき、元の暗号文をそのまま保持して上書きしないこと
/// (空文字で保存し直すと、保存済みのパスワードが失われるため)
pub fn decrypt(key: &[u8; 32], stored: &str) -> Option<String> {
    let Some(b64) = stored.strip_prefix(ENC_PREFIX) else {
        return Some(stored.to_string());
    };
    let data = B64.decode(b64).ok()?;
    if data.len() < 12 {
        return None;
    }
    let (nonce, ct) = data.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plain = cipher.decrypt(Nonce::from_slice(nonce), ct).ok()?;
    String::from_utf8(plain).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let key = [7u8; 32];
        let enc = encrypt(&key, "p@ss日本語").unwrap();
        assert!(enc.starts_with(ENC_PREFIX));
        assert_eq!(decrypt(&key, &enc).as_deref(), Some("p@ss日本語"));
        // 平文(旧形式)はそのまま
        assert_eq!(decrypt(&key, "plain").as_deref(), Some("plain"));
        // 空文字はそのまま
        assert_eq!(encrypt(&key, "").unwrap(), "");
        // 別の鍵では復号できない (空文字ではなくNone)
        let other = [9u8; 32];
        assert_eq!(decrypt(&other, &enc), None);
        // 二重暗号化はしない
        assert_eq!(encrypt(&key, &enc).unwrap(), enc);
    }

    #[test]
    fn プレフィックスで始まるパスワードも暗号化する() {
        let key = [7u8; 32];
        // 暗号文の形をしていない (base64として短すぎる) ので、ただの平文として扱う
        let plain = "enc:v1:hello";
        let enc = encrypt(&key, plain).unwrap();
        assert_ne!(enc, plain, "平文のまま保存してはいけない");
        assert_eq!(decrypt(&key, &enc).as_deref(), Some(plain));
        assert!(!looks_encrypted(plain));
        assert!(looks_encrypted(&enc));
    }

    #[test]
    fn 予備の鍵でも復号できる() {
        let now = [7u8; 32];
        let old = [9u8; 32];
        // 昔の鍵で保存した値
        let enc = encrypt(&old, "秘密").unwrap();
        let keys = MasterKeys {
            primary: now,
            fallbacks: vec![old],
        };
        assert_eq!(keys.decrypt(&enc).as_deref(), Some("秘密"));
        // 今の鍵で保存した値も読める
        let fresh = encrypt(&now, "新しい").unwrap();
        assert_eq!(keys.decrypt(&fresh).as_deref(), Some("新しい"));
        // どちらの鍵でも読めない値は None (空文字にしない)
        let unknown = encrypt(&[1u8; 32], "他").unwrap();
        assert_eq!(keys.decrypt(&unknown), None);
    }

    #[test]
    fn 予備の鍵が無ければ今の鍵だけで判断する() {
        let keys = MasterKeys {
            primary: [7u8; 32],
            fallbacks: Vec::new(),
        };
        let enc = encrypt(&[9u8; 32], "秘密").unwrap();
        assert_eq!(keys.decrypt(&enc), None);
    }
}
