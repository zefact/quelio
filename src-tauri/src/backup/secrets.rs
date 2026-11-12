//! 接続一覧のバックアップに入れるパスワード・SSHのパスフレーズ。
//!
//! アプリのマスターキー (OSのキーチェーン) は別のPCへ持っていけないので使わない。
//! 書き出すときに利用者が決めたパスワードから鍵を作り (Argon2id)、
//! 接続先ごとの値を1つにまとめて AES-256-GCM で暗号化する。
//! パスワードを知らなければ中身は読めず、書き換えられていれば復号で気づける

use std::collections::BTreeMap;

use aes_gcm::aead::{Aead, Generate, KeyInit, Nonce};
use aes_gcm::{Aes256Gcm, Key};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

/// 鍵の作り方の名前 (読み込むときに確かめる)
const KDF: &str = "argon2id";

/**
 * 鍵を作るときの重さ (Argon2のメモリ・回数・並列数)。
 *
 * ライブラリの既定値に任せると、版が上がって既定値が変わったときに
 * 同じパスワードから別の鍵ができ、古いバックアップが「パスワード違い」で開けなくなる。
 * 書き出すときに値をファイルへ残し、読むときはファイルの値で作る
 */
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    /// メモリ (KiB)
    pub m: u32,
    /// 回数
    pub t: u32,
    /// 並列数
    pub p: u32,
}

/// 書き出すときの重さ。
/// 値を残していない (0.9.12〜0.9.13で書き出した) ファイルもこの値で作っている
/// (当時の argon2 0.6.0 の既定値。Argon2id / v0x13)
const PARAMS: KdfParams = KdfParams {
    m: 19 * 1024,
    t: 2,
    p: 1,
};

/// ファイルに書かれた重さとして受け付ける上限。
/// 細工したファイルで、読み込むだけで大量のメモリと時間を使わせないため
const MAX_PARAMS: KdfParams = KdfParams {
    m: 1024 * 1024,
    t: 16,
    p: 16,
};

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
    /// 鍵を作ったときの重さ。0.9.13までのファイルには無い (そのときは `PARAMS`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<KdfParams>,
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
fn derive(password: &str, salt: &[u8], kp: KdfParams) -> Result<[u8; 32], String> {
    if kp.m > MAX_PARAMS.m || kp.t > MAX_PARAMS.t || kp.p > MAX_PARAMS.p {
        return Err("このバックアップのパスワードの形式には対応していません".to_string());
    }
    let params = Params::new(kp.m, kp.t, kp.p, Some(32))
        .map_err(|e| format!("鍵を作れませんでした: {e}"))?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("鍵を作れませんでした: {e}"))?;
    Ok(key)
}

/// 秘匿値をまとめて暗号化する
pub fn seal(secrets: &Secrets, password: &str) -> Result<SecretBox, String> {
    check_password(password)?;
    let salt: [u8; 16] = rand_bytes();
    let mut key = derive(password, &salt, PARAMS)?;
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(key));
    key.zeroize();
    let nonce = Nonce::<Aes256Gcm>::generate();
    let mut plain = serde_json::to_vec(secrets).map_err(|e| format!("シリアライズに失敗: {e}"))?;
    let data = cipher
        .encrypt(&nonce, plain.as_ref())
        .map_err(|e| format!("暗号化に失敗しました: {e}"));
    plain.zeroize();
    Ok(SecretBox {
        kdf: KDF.to_string(),
        params: Some(PARAMS),
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
    let mut key = derive(password, &salt, sealed.params.unwrap_or(PARAMS))?;
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(key));
    key.zeroize();
    let nonce = Nonce::<Aes256Gcm>::try_from(nonce.as_slice()).map_err(|_| broken())?;
    // 鍵が違っても、中身が書き換えられていても、ここで失敗する (どちらかは見分けられない)
    let mut plain = cipher
        .decrypt(&nonce, data.as_ref())
        .map_err(|_| "バックアップのパスワードが違います".to_string())?;
    let out = serde_json::from_slice(&plain).map_err(|_| broken());
    plain.zeroize();
    out
}

/// 暗号に使う乱数 (OSの乱数)
fn rand_bytes<const N: usize>() -> [u8; N] {
    <[u8; N]>::generate()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 書き出す重さは当時の既定値と同じ() {
        // 値を残していない古いファイルは、この値で作った鍵で開く
        let d = Params::default();
        assert_eq!(
            (PARAMS.m, PARAMS.t, PARAMS.p),
            (d.m_cost(), d.t_cost(), d.p_cost())
        );
    }

    #[test]
    fn 重さを残していない古いファイルも開ける() {
        let mut sealed = seal(&sample(), "backup-pass").unwrap();
        assert_eq!(sealed.params, Some(PARAMS));
        // 0.9.13までのファイル (params が無い)
        sealed.params = None;
        let text = serde_json::to_string(&sealed).unwrap();
        assert!(!text.contains("params"));
        let old: SecretBox = serde_json::from_str(&text).unwrap();
        assert_eq!(open(&old, "backup-pass").unwrap(), sample());
    }

    #[test]
    fn 重すぎる指定のファイルは開かない() {
        let mut sealed = seal(&sample(), "backup-pass").unwrap();
        sealed.params = Some(KdfParams {
            m: u32::MAX,
            t: 2,
            p: 1,
        });
        assert!(open(&sealed, "backup-pass").is_err());
    }

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
