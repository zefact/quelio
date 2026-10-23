//! アプリデータのエクスポート/インポート
//! (接続一覧・ER図・SQLのお気に入り・固定長のお気に入り)。
//! 設定画面から呼ばれ、指定パスのJSONファイルと相互変換する。

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::csv_layouts;
use crate::er_store;
use crate::models::ConnectionStore;
use crate::saved_sql;
use crate::storage;

/// バックアップに入れるパスワード・パスフレーズの暗号化
mod secrets;
use secrets::{Secret, SecretBox, Secrets};

/// インポート結果 (追加数・上書き数)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub added: usize,
    pub updated: usize,
    /// パスワード・パスフレーズを取り込んだ接続先の数 (接続一覧のときだけ)
    pub secrets: usize,
}

/// 接続一覧を書き出した結果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsExported {
    /// 書き出した接続先の数
    pub count: usize,
    /// パスワード・パスフレーズを入れた接続先の数
    pub secrets: usize,
    /// 保存されたパスワードを復号できず、入れられなかった接続先の数
    pub locked: usize,
}

/// 接続一覧のバックアップファイルの中身 (取り込む前に確かめる用)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsFileInfo {
    pub connections: usize,
    /// パスワード・パスフレーズが (暗号化して) 入っているか
    pub has_secrets: bool,
}

/// ファイルの中で、暗号化した秘匿値を置く場所
const SECRETS_KEY: &str = "secrets";

/**
 * 接続一覧をJSONファイルへ書き出す。
 *
 * パスワード・SSHパスフレーズは、ふだんは含めない。
 * `secret_password` を渡したときだけ、それから作った鍵で暗号化して一緒に入れる
 * (平文では書かない。アプリの鍵は別のPCで使えないので、利用者のパスワードを使う)
 */
pub fn export_connections(
    app: &AppHandle,
    path: &str,
    secret_password: Option<&str>,
) -> Result<ConnectionsExported, String> {
    let mut store = storage::load(app)?;
    // 書き出す前に、入れる秘匿値を抜き出しておく (伏せる前の復号済みの値から)
    let mut sealed = None;
    let mut secret_count = 0;
    let mut locked = 0;
    if let Some(pw) = secret_password {
        let (secrets, n_locked) = collect_secrets(&store);
        locked = n_locked;
        secret_count = secrets.len();
        sealed = Some(secrets::seal(&secrets, pw)?);
    }
    for c in &mut store.connections {
        c.password = String::new();
        c.password_locked = false;
        // 「保存済み」の目印は書き出し先では意味がない
        c.password_saved = false;
        c.passphrase_saved = false;
        if let Some(ssh) = &mut c.ssh {
            ssh.passphrase = None;
        }
    }
    let mut value =
        serde_json::to_value(&store).map_err(|e| format!("シリアライズに失敗: {e}"))?;
    if let (Some(sealed), Some(obj)) = (sealed, value.as_object_mut()) {
        obj.insert(
            SECRETS_KEY.to_string(),
            serde_json::to_value(sealed).map_err(|e| format!("シリアライズに失敗: {e}"))?,
        );
    }
    let text =
        serde_json::to_string_pretty(&value).map_err(|e| format!("シリアライズに失敗: {e}"))?;
    // 接続先の一覧なので、所有者だけが読める権限で書き出す
    crate::outfile::write(path.as_ref(), text)
        .map_err(|e| format!("ファイルを書き込めません: {e}"))?;
    Ok(ConnectionsExported {
        count: store.connections.len(),
        secrets: secret_count,
        locked,
    })
}

/// 復号済みの接続一覧から、入れる秘匿値を抜き出す (復号できなかったものは数だけ返す)
fn collect_secrets(store: &ConnectionStore) -> (Secrets, usize) {
    let mut out = Secrets::new();
    let mut locked = 0;
    for c in &store.connections {
        // 暗号文のまま入っている値は、別のPCでは役に立たないので入れない
        if c.password_locked {
            locked += 1;
            continue;
        }
        let passphrase = c
            .ssh
            .as_ref()
            .and_then(|s| s.passphrase.clone())
            .filter(|p| !p.is_empty());
        if c.password.is_empty() && passphrase.is_none() {
            continue;
        }
        out.insert(
            c.id.clone(),
            Secret {
                password: c.password.clone(),
                passphrase,
            },
        );
    }
    (out, locked)
}

/// 接続一覧のファイルを読み、接続先と暗号化した秘匿値に分ける
fn read_connections_file(path: &str) -> Result<(ConnectionStore, Option<SecretBox>), String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    parse_connections(&text)
}

/// 接続一覧のJSONを、接続先と暗号化した秘匿値に分ける
fn parse_connections(text: &str) -> Result<(ConnectionStore, Option<SecretBox>), String> {
    let mut value: Value =
        serde_json::from_str(text).map_err(|e| format!("接続一覧のJSON形式が不正です: {e}"))?;
    let sealed = match value.as_object_mut().and_then(|o| o.remove(SECRETS_KEY)) {
        Some(v) => Some(
            serde_json::from_value::<SecretBox>(v)
                .map_err(|_| "バックアップのパスワード部分が壊れています".to_string())?,
        ),
        None => None,
    };
    let store: ConnectionStore =
        serde_json::from_value(value).map_err(|e| format!("接続一覧のJSON形式が不正です: {e}"))?;
    Ok((store, sealed))
}

/// 取り込む前に、ファイルの中身を確かめる (パスワードが入っているか)
pub fn inspect_connections_file(path: &str) -> Result<ConnectionsFileInfo, String> {
    let (store, sealed) = read_connections_file(path)?;
    Ok(ConnectionsFileInfo {
        connections: store.connections.len(),
        has_secrets: sealed.is_some(),
    })
}

/**
 * JSONファイルから接続一覧を取り込む。
 *
 * idが一致する既存プロファイルは上書き (パスワード未設定なら既存を保持)、
 * それ以外は追加する。
 * ファイルにパスワードが入っていて `secret_password` を渡したときは、
 * 取り出してその接続先のパスワード・パスフレーズにする
 * (パスワードが違えば何も取り込まずに断る)
 */
pub fn import_connections(
    app: &AppHandle,
    path: &str,
    secret_password: Option<&str>,
) -> Result<ImportResult, String> {
    let (incoming, sealed) = read_connections_file(path)?;
    let secrets = match (sealed, secret_password) {
        (Some(sealed), Some(pw)) => secrets::open(&sealed, pw)?,
        _ => Secrets::new(),
    };
    let mut secret_count = 0;

    let mut store = storage::load(app)?;
    // 取り込みでAIへの公開が変わることがある (前後の姿を見比べる)
    let before = crate::commands::ai_visible_list(&store);
    let mut added = 0;
    let mut updated = 0;

    for f in incoming.folders {
        if let Some(existing) = store.folders.iter_mut().find(|x| x.id == f.id) {
            *existing = f;
        } else {
            store.folders.push(f);
        }
    }

    for mut c in incoming.connections {
        // ファイルに入っていたパスワード・パスフレーズを戻す (IDを振り直す前に引く)
        let secret = secrets.get(&c.id);
        if apply_secret(&mut c, secret) {
            secret_count += 1;
        }
        if c.id.is_empty() {
            c.id = uuid::Uuid::new_v4().to_string();
        }
        if let Some(existing) = store.connections.iter_mut().find(|x| x.id == c.id) {
            // エクスポートには秘匿情報が入っていないため、
            // 未設定のパスワード・パスフレーズは既存の値を引き継ぐ
            if c.password.is_empty() {
                c.password = existing.password.clone();
            }
            if let (Some(ssh_new), Some(ssh_old)) = (c.ssh.as_mut(), existing.ssh.as_ref()) {
                if ssh_new.passphrase.as_deref().unwrap_or("").is_empty() {
                    ssh_new.passphrase = ssh_old.passphrase.clone();
                }
            }
            *existing = c;
            updated += 1;
        } else {
            store.connections.push(c);
            added += 1;
        }
    }

    storage::save(app, &store)?;
    // 保存や削除と同じく、見える一覧が変わったらクライアントへ知らせる
    if crate::commands::ai_visible_list(&store) != before {
        crate::commands::notify_ai_list_changed(app);
    }
    Ok(ImportResult {
        added,
        updated,
        secrets: secret_count,
    })
}

/// 取り出したパスワード・パスフレーズを接続先へ入れる (入れたら true)
fn apply_secret(c: &mut crate::models::ConnectionProfile, secret: Option<&Secret>) -> bool {
    let Some(secret) = secret else {
        return false;
    };
    let mut applied = false;
    if !secret.password.is_empty() {
        c.password = secret.password.clone();
        applied = true;
    }
    if let (Some(p), Some(ssh)) = (&secret.passphrase, c.ssh.as_mut()) {
        ssh.passphrase = Some(p.clone());
        applied = true;
    }
    if applied {
        c.password_locked = false;
    }
    applied
}

/// 全ER図をJSONファイルへ書き出す
pub fn export_er_diagrams(app: &AppHandle, path: &str) -> Result<usize, String> {
    let all = er_store::all(app)?;
    let text =
        serde_json::to_string_pretty(&all).map_err(|e| format!("シリアライズに失敗: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("ファイルを書き込めません: {e}"))?;
    Ok(all.len())
}

/// JSONファイルからER図を取り込む (同名の図は上書き)
pub fn import_er_diagrams(app: &AppHandle, path: &str) -> Result<ImportResult, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    let incoming: HashMap<String, Value> =
        serde_json::from_str(&text).map_err(|e| format!("ER図のJSON形式が不正です: {e}"))?;
    let (added, updated) = er_store::merge(app, incoming)?;
    Ok(ImportResult {
        added,
        updated,
        secrets: 0,
    })
}

/// 保存SQL (お気に入り) をJSONファイルへ書き出す
pub fn export_saved_sql(app: &AppHandle, path: &str) -> Result<usize, String> {
    let store = saved_sql::load(app)?;
    let text =
        serde_json::to_string_pretty(&store).map_err(|e| format!("シリアライズに失敗: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("ファイルを書き込めません: {e}"))?;
    Ok(store.items.len())
}

/// JSONファイルから保存SQLを取り込む (同じIDのものは上書き)
pub fn import_saved_sql(app: &AppHandle, path: &str) -> Result<ImportResult, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    let incoming = saved_sql::parse(&text)?;
    let (added, updated) = saved_sql::merge(app, incoming)?;
    Ok(ImportResult {
        added,
        updated,
        secrets: 0,
    })
}

/// 固定長のお気に入りをJSONファイルへ書き出す (フォルダ分けごと)
pub fn export_csv_layouts(app: &AppHandle, path: &str) -> Result<usize, String> {
    let nodes = csv_layouts::tree(app)?;
    let text =
        serde_json::to_string_pretty(&nodes).map_err(|e| format!("シリアライズに失敗: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("ファイルを書き込めません: {e}"))?;
    Ok(csv_layouts::flatten(&nodes).len())
}

/// JSONファイルから固定長のお気に入りを取り込む (同じ名前のものは上書き)
pub fn import_csv_layouts(app: &AppHandle, path: &str) -> Result<ImportResult, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    let incoming = csv_layouts::parse(&text)?;
    let (added, updated) = csv_layouts::merge(app, incoming)?;
    Ok(ImportResult {
        added,
        updated,
        secrets: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(with_secrets: bool) -> String {
        let mut v = serde_json::json!({
            "connections": [{
                "id": "a", "name": "本番", "dbType": "postgresql",
                "host": "db", "port": 5432, "user": "app", "password": "",
                "ssh": {"enabled": true, "host": "bastion", "port": 22, "user": "ops", "keyPath": ""}
            }]
        });
        if with_secrets {
            let mut s = Secrets::new();
            s.insert(
                "a".into(),
                Secret {
                    password: "pw".into(),
                    passphrase: Some("pp".into()),
                },
            );
            v["secrets"] = serde_json::to_value(secrets::seal(&s, "backup-pass").unwrap()).unwrap();
        }
        v.to_string()
    }

    #[test]
    fn パスワード入りのファイルを読み分ける() {
        let (store, sealed) = parse_connections(&file(true)).unwrap();
        assert_eq!(store.connections.len(), 1);
        let secrets = secrets::open(&sealed.unwrap(), "backup-pass").unwrap();
        let mut c = store.connections[0].clone();
        assert!(apply_secret(&mut c, secrets.get("a")));
        assert_eq!(c.password, "pw");
        assert_eq!(c.ssh.unwrap().passphrase.as_deref(), Some("pp"));
    }

    #[test]
    fn パスワードの無いファイルも読める() {
        let (store, sealed) = parse_connections(&file(false)).unwrap();
        assert_eq!(store.connections.len(), 1);
        assert!(sealed.is_none());
    }

    #[test]
    fn 入っていない接続先はそのまま() {
        let (store, _) = parse_connections(&file(false)).unwrap();
        let mut c = store.connections[0].clone();
        assert!(!apply_secret(&mut c, None));
        assert_eq!(c.password, "");
    }
}
