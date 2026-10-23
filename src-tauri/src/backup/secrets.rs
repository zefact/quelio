//! 接続一覧のバックアップに入れるパスワード・SSHのパスフレーズ。
//!
//! アプリのマスターキー (OSのキーチェーン) は別のPCへ持っていけないので使わない。
//! 書き出すときに利用者が決めたパスワードから鍵を作り (Argon2id)、
//! 接続先ごとの値を1つにまとめて AES-256-GCM で暗号化する。
//! パスワードを知らなければ中身は読めず、書き換えられていれば復号で気づける

use std::collections::BTreeMap;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::Argon2;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

/// 鍵の作り方の名前 (読み込むときに確かめる)
const KDF: &str = "argon2id";

/// バックアップのパスワードの最短の長さ
pub const MIN_PASSWORD_LEN: usize = 8;

/// 接続先1つぶんの秘匿値
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secret {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub password: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.password.zeroize();
        if let Some(p) = &mut self.passphrase {
            p.zeroize();
        }
    }
}

/// 接続先のID → 秘匿値
pub type Secrets = BTreeMap<String, Secret>;

/// ファイルに書く、暗号化した秘匿値のまとまり
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretBox {
    pub kdf: String,
    pub salt: String,
    pub nonce: String,
    pub data: String,
}

/// バックアップのパスワードとして受け付けるか
pub fn check_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(format!(
            "バックアップのパスワードは{MIN_PASSWORD_LEN}文字以上にしてください"
        ));
    }
    Ok(())
}

/// パスワードと塩から鍵を作る
fn derive(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("鍵を作れませんでした: {e}"))?;
    Ok(key)
}

/// 秘匿値をまとめて暗号化する
pub fn seal(secrets: &Secrets, password: &str) -> Result<SecretBox, String> {
    check_password(password)?;
    let salt: [u8; 16] = rand_bytes();
    let mut key = derive(password, &salt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    key.zeroize();
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut plain = serde_json::to_vec(secrets).map_err(|e| format!("シリアライズに失敗: {e}"))?;
    let data = cipher
        .encrypt(&nonce, plain.as_ref())
        .map_err(|e| format!("暗号化に失敗しました: {e}"));
    plain.zeroize();
    Ok(SecretBox {
        kdf: KDF.to_string(),
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        data: B64.encode(data?),
    })
}

/// 暗号化した秘匿値を、パスワードで取り出す
pub fn open(sealed: &SecretBox, password: &str) -> Result<Secrets, String> {
    if sealed.kdf != KDF {
        return Err(format!(
            "このバックアップのパスワードの形式 ({}) には対応していません",
            sealed.kdf
        ));
    }
    let broken = || "バックアップのパスワード部分が壊れています".to_string();
    let salt = B64.decode(&sealed.salt).map_err(|_| broken())?;
    let nonce = B64.decode(&sealed.nonce).map_err(|_| broken())?;
    let data = B64.decode(&sealed.data).map_err(|_| broken())?;
    if nonce.len() != 12 {
        return Err(broken());
    }
    let mut key = derive(password, &salt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    key.zeroize();
    // 鍵が違っても、中身が書き換えられていても、ここで失敗する (どちらかは見分けられない)
    let mut plain = cipher
        .decrypt(Nonce::from_slice(&nonce), data.as_ref())
        .map_err(|_| "バックアップのパスワードが違います".to_string())?;
    let out = serde_json::from_slice(&plain).map_err(|_| broken());
    plain.zeroize();
    out
}

/// 暗号に使う乱数
fn rand_bytes<const N: usize>() -> [u8; N] {
    use aes_gcm::aead::rand_core::RngCore;
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Secrets {
        let mut s = Secrets::new();
        s.insert(
            "a".into(),
            Secret {
                password: "pw-a".into(),
                passphrase: Some("pp-a".into()),
            },
        );
        s.insert(
            "b".into(),
            Secret {
                password: "pw-b".into(),
                passphrase: None,
            },
        );
        s
    }

    #[test]
    fn 同じパスワードで取り出せる() {
        let sealed = seal(&sample(), "correct horse").unwrap();
        assert_eq!(open(&sealed, "correct horse").unwrap(), sample());
    }

    #[test]
    fn 違うパスワードでは取り出せない() {
        let sealed = seal(&sample(), "correct horse").unwrap();
        let e = open(&sealed, "wrong horse!").unwrap_err();
        assert!(e.contains("違います"), "{e}");
    }

    #[test]
    fn 書き換えられていれば取り出せない() {
        let mut sealed = seal(&sample(), "correct horse").unwrap();
        let mut data = B64.decode(&sealed.data).unwrap();
        data[0] ^= 1;
        sealed.data = B64.encode(data);
        assert!(open(&sealed, "correct horse").is_err());
    }

    #[test]
    fn 平文はファイルに残らない() {
        let sealed = seal(&sample(), "correct horse").unwrap();
        let text = serde_json::to_string(&sealed).unwrap();
        assert!(!text.contains("pw-a") && !text.contains("pp-a"));
    }

    #[test]
    fn 短いパスワードは断る() {
        assert!(seal(&sample(), "short").is_err());
    }

    #[test]
    fn 毎回ちがう塩で暗号化する() {
        let a = seal(&sample(), "correct horse").unwrap();
        let b = seal(&sample(), "correct horse").unwrap();
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.data, b.data);
    }
}
