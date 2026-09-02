//! Valkey (Redis互換) 接続とコマンド実行。
//! sqlx系のセッションと同じ仕組みに載せるための薄いラッパー

use redis::aio::MultiplexedConnection;
use serde::{Deserialize, Serialize};
use tokio::time::{timeout, Duration};

use crate::db::CONNECT_TIMEOUT;

/// コマンド実行のタイムアウト
const EXEC_TIMEOUT: Duration = Duration::from_secs(60);
/// キー一覧1回のSCANで要求する件数
pub const SCAN_COUNT: usize = 500;
/// キー詳細で一度に取得する要素数
const DETAIL_LIMIT: usize = 200;
/// 値プレビューの最大バイト数 (巨大なstringでUIが固まらないように)
const VALUE_PREVIEW_BYTES: usize = 4096;

pub fn format_err(e: redis::RedisError) -> String {
    format!("Valkeyエラー: {e}")
}

/// 接続を確立してDBを選択する (user/passwordは空文字なら送らない)
///
/// * `use_tls` - TLSで接続する (AWS ElastiCache等のin-transit暗号化)
/// * `sni_host` - TLSのSNI/証明書検証に使うホスト名。SSHトンネル経由では
///   接続先が127.0.0.1になるため、本来の接続先ホスト名を渡す。
///   AWS ElastiCacheはSNIの無いTLS接続を切断するため、redisクレートの
///   insecure接続 (SNI無効) ではなく自前でハンドシェイクする
pub async fn connect(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    db_index: i64,
    use_tls: bool,
    sni_host: Option<&str>,
) -> Result<MultiplexedConnection, String> {
    timeout(
        CONNECT_TIMEOUT,
        connect_inner(host, port, user, password, db_index, use_tls, sni_host),
    )
    .await
    .map_err(|_| crate::apperr::timeout_message("Valkey接続"))?
}

async fn connect_inner(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    db_index: i64,
    use_tls: bool,
    sni_host: Option<&str>,
) -> Result<MultiplexedConnection, String> {
    let info = redis::RedisConnectionInfo {
        db: db_index,
        username: Some(user.to_string()).filter(|s| !s.is_empty()),
        password: Some(password.to_string()).filter(|s| !s.is_empty()),
        ..Default::default()
    };

    let tcp = tokio::net::TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("Valkeyに接続できません: {e}"))?;
    let _ = tcp.set_nodelay(true);

    if use_tls {
        use tokio_rustls::rustls::{pki_types::ServerName, ClientConfig, RootCertStore};

        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let name = sni_host.unwrap_or(host).to_string();
        let server_name =
            ServerName::try_from(name).map_err(|e| format!("TLSサーバー名が不正です: {e}"))?;
        let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config));
        let tls = connector
            .connect(server_name, tcp)
            .await
            .map_err(|e| {
                format!(
                    "TLSハンドシェイクに失敗しました: {e}\n接続先のin-transit暗号化が無効の場合は「TLSで接続」をオフにしてください"
                )
            })?;

        let (conn, driver) = redis::aio::MultiplexedConnection::new(&info, tls)
            .await
            .map_err(|e| map_setup_err(e, use_tls))?;
        tokio::spawn(driver);
        Ok(conn)
    } else {
        let (conn, driver) = redis::aio::MultiplexedConnection::new(&info, tcp)
            .await
            .map_err(|e| map_setup_err(e, use_tls))?;
        tokio::spawn(driver);
        Ok(conn)
    }
}

/// 接続セットアップ (AUTH/SELECT) 時のエラーを整形する
fn map_setup_err(e: redis::RedisError, use_tls: bool) -> String {
    let msg = format_err(e);
    // TLS必須のサーバーへ平文で繋ぐと接続が即切断されるため、ヒントを添える
    if !use_tls
        && (msg.contains("unexpectedly terminated")
            || msg.contains("Connection reset")
            || msg.contains("broken pipe"))
    {
        format!(
            "{msg}\nTLS (in-transit暗号化) が必須のサーバーの可能性があります。接続設定で「TLSで接続」を有効にしてください"
        )
    } else {
        msg
    }
}

/// INFOから1項目を取り出す
fn info_get(info: &str, key: &str) -> Option<String> {
    info.lines()
        .find(|l| l.starts_with(key) && l.as_bytes().get(key.len()) == Some(&b':'))
        .map(|l| l[key.len() + 1..].trim().to_string())
}

/// サーバー情報チップ用の (ラベル, 値) 一覧を返す
/// 論理DBの数を返す (`CONFIG GET databases`)。
///
/// 既定は16だが、設定で変えられる。
/// CONFIG を禁じている構成 (マネージドサービス等) では取れないので、
/// その場合は既定の16として扱う
pub async fn db_count(conn: &mut MultiplexedConnection) -> i64 {
    let res: Result<Vec<String>, _> = redis::cmd("CONFIG")
        .arg("GET")
        .arg("databases")
        .query_async(conn)
        .await;
    // 返りは ["databases", "16"] の並び
    res.ok()
        .and_then(|v| v.get(1).and_then(|s| s.parse::<i64>().ok()))
        .filter(|n| (1..=1024).contains(n))
        .unwrap_or(16)
}

pub async fn server_info(
    conn: &mut MultiplexedConnection,
) -> Result<Vec<(String, String)>, String> {
    let info: String = redis::cmd("INFO")
        .query_async(conn)
        .await
        .map_err(format_err)?;

    let mut out = Vec::new();
    // Valkeyはvalkey_version、Redis互換モードではredis_versionを返す
    if let Some(v) = info_get(&info, "valkey_version") {
        out.push(("バージョン".to_string(), format!("Valkey {v}")));
    } else if let Some(v) = info_get(&info, "redis_version") {
        out.push(("バージョン".to_string(), format!("Redis {v}")));
    }
    if let Some(v) = info_get(&info, "redis_mode") {
        if v != "standalone" {
            out.push(("モード".to_string(), v));
        }
    }
    if let Some(v) = info_get(&info, "role") {
        out.push(("ロール".to_string(), v));
    }
    if let Some(v) = info_get(&info, "used_memory_human") {
        out.push(("メモリ".to_string(), v));
    }
    if let Some(v) = info_get(&info, "maxmemory_human") {
        if v != "0B" {
            out.push(("メモリ上限".to_string(), v));
        }
    }
    if let Some(v) = info_get(&info, "connected_clients") {
        out.push(("クライアント".to_string(), v));
    }
    // ヒット率 (hits / (hits + misses))
    if let (Some(h), Some(m)) = (
        info_get(&info, "keyspace_hits").and_then(|v| v.parse::<f64>().ok()),
        info_get(&info, "keyspace_misses").and_then(|v| v.parse::<f64>().ok()),
    ) {
        if h + m > 0.0 {
            out.push((
                "ヒット率".to_string(),
                format!("{:.1}%", h / (h + m) * 100.0),
            ));
        }
    }
    Ok(out)
}

// ---------- キー一覧 ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvKeyInfo {
    pub key: String,
    #[serde(rename = "type")]
    pub kv_type: String,
    /// 残りTTL秒 (-1: 無期限 / -2: 消滅)
    pub ttl: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvScanResult {
    pub entries: Vec<KvKeyInfo>,
    /// 続きを読むためのカーソル ("0"なら終端)
    pub cursor: String,
    pub done: bool,
    /// 選択中DBの総キー数 (概算表示用)
    pub dbsize: i64,
}

/// SCANでキーを1ページぶん取得し、各キーの型とTTLも引く
pub async fn scan(
    conn: &mut MultiplexedConnection,
    pattern: &str,
    cursor: &str,
) -> Result<KvScanResult, String> {
    let pattern = if pattern.trim().is_empty() {
        "*"
    } else {
        pattern.trim()
    };
    let (next, keys): (String, Vec<Vec<u8>>) = redis::cmd("SCAN")
        .arg(cursor)
        .arg("MATCH")
        .arg(pattern)
        .arg("COUNT")
        .arg(SCAN_COUNT)
        .query_async(conn)
        .await
        .map_err(format_err)?;

    // 型とTTLをパイプラインでまとめて取得する (キーごとの往復を避ける)
    let mut entries = Vec::with_capacity(keys.len());
    if !keys.is_empty() {
        let mut pipe = redis::pipe();
        for k in &keys {
            pipe.cmd("TYPE").arg(k);
            pipe.cmd("TTL").arg(k);
        }
        let vals: Vec<redis::Value> = pipe.query_async(conn).await.map_err(format_err)?;
        for (i, k) in keys.iter().enumerate() {
            let kv_type = vals.get(i * 2).map(value_to_plain).unwrap_or_default();
            let ttl = match vals.get(i * 2 + 1) {
                Some(redis::Value::Int(n)) => *n,
                _ => -1,
            };
            entries.push(KvKeyInfo {
                key: String::from_utf8_lossy(k).to_string(),
                kv_type,
                ttl,
            });
        }
    }
    entries.sort_by(|a, b| a.key.cmp(&b.key));

    let dbsize: i64 = redis::cmd("DBSIZE")
        .query_async(conn)
        .await
        .unwrap_or(-1);

    Ok(KvScanResult {
        done: next == "0",
        cursor: next,
        entries,
        dbsize,
    })
}

// ---------- キー詳細 ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvKeyDetail {
    pub key: String,
    #[serde(rename = "type")]
    pub kv_type: String,
    pub ttl: i64,
    /// MEMORY USAGE (取得できない場合はNone)
    pub memory: Option<i64>,
    pub encoding: Option<String>,
    /// 総要素数 (stringはバイト長)
    pub total: i64,
    /// 値ビューの列ラベル
    pub cols: (String, String),
    /// 値 (先頭DETAIL_LIMIT件のみ)
    pub rows: Vec<(String, String)>,
    pub truncated: bool,
}

/// キーの詳細 (型・TTL・メモリ・値プレビュー) を返す
pub async fn key_detail(
    conn: &mut MultiplexedConnection,
    key: &str,
) -> Result<KvKeyDetail, String> {
    let kv_type: String = redis::cmd("TYPE")
        .arg(key)
        .query_async(conn)
        .await
        .map_err(format_err)?;
    if kv_type == "none" {
        return Err(format!("キーが存在しません: {key}"));
    }
    let ttl: i64 = redis::cmd("TTL")
        .arg(key)
        .query_async(conn)
        .await
        .map_err(format_err)?;
    let memory: Option<i64> = redis::cmd("MEMORY")
        .arg("USAGE")
        .arg(key)
        .query_async(conn)
        .await
        .ok();
    let encoding: Option<String> = redis::cmd("OBJECT")
        .arg("ENCODING")
        .arg(key)
        .query_async(conn)
        .await
        .ok();

    let (total, cols, rows): (i64, (String, String), Vec<(String, String)>) = match kv_type
        .as_str()
    {
        "string" => {
            let len: i64 = redis::cmd("STRLEN")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            let raw: Vec<u8> = redis::cmd("GETRANGE")
                .arg(key)
                .arg(0)
                .arg(VALUE_PREVIEW_BYTES as i64 - 1)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            let text = bytes_to_display(&raw);
            (
                len,
                ("項目".to_string(), "値".to_string()),
                vec![("値".to_string(), text)],
            )
        }
        "hash" => {
            let len: i64 = redis::cmd("HLEN")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            let (_c, flat): (String, Vec<Vec<u8>>) = redis::cmd("HSCAN")
                .arg(key)
                .arg(0)
                .arg("COUNT")
                .arg(DETAIL_LIMIT)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            let rows = flat
                .chunks(2)
                .map(|p| {
                    (
                        bytes_to_display(p.first().map(Vec::as_slice).unwrap_or(b"")),
                        bytes_to_display(p.get(1).map(Vec::as_slice).unwrap_or(b"")),
                    )
                })
                .collect();
            (len, ("フィールド".to_string(), "値".to_string()), rows)
        }
        "list" => {
            let len: i64 = redis::cmd("LLEN")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            let items: Vec<Vec<u8>> = redis::cmd("LRANGE")
                .arg(key)
                .arg(0)
                .arg(DETAIL_LIMIT as i64 - 1)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            let rows = items
                .iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), bytes_to_display(v)))
                .collect();
            (len, ("index".to_string(), "値".to_string()), rows)
        }
        "set" => {
            let len: i64 = redis::cmd("SCARD")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            let (_c, items): (String, Vec<Vec<u8>>) = redis::cmd("SSCAN")
                .arg(key)
                .arg(0)
                .arg("COUNT")
                .arg(DETAIL_LIMIT)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            let rows = items
                .iter()
                .enumerate()
                .map(|(i, v)| ((i + 1).to_string(), bytes_to_display(v)))
                .collect();
            (len, ("#".to_string(), "メンバー".to_string()), rows)
        }
        "zset" => {
            let len: i64 = redis::cmd("ZCARD")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            let flat: Vec<Vec<u8>> = redis::cmd("ZRANGE")
                .arg(key)
                .arg(0)
                .arg(DETAIL_LIMIT as i64 - 1)
                .arg("WITHSCORES")
                .query_async(conn)
                .await
                .map_err(format_err)?;
            let rows = flat
                .chunks(2)
                .map(|p| {
                    (
                        bytes_to_display(p.get(1).map(Vec::as_slice).unwrap_or(b"")),
                        bytes_to_display(p.first().map(Vec::as_slice).unwrap_or(b"")),
                    )
                })
                .collect();
            (len, ("スコア".to_string(), "メンバー".to_string()), rows)
        }
        "stream" => {
            let len: i64 = redis::cmd("XLEN")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            let val: redis::Value = redis::cmd("XRANGE")
                .arg(key)
                .arg("-")
                .arg("+")
                .arg("COUNT")
                .arg(DETAIL_LIMIT)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            let mut rows = Vec::new();
            if let redis::Value::Array(items) = val {
                for item in items {
                    if let redis::Value::Array(pair) = item {
                        let id = pair.first().map(value_to_plain).unwrap_or_default();
                        let fields = pair.get(1).map(value_to_plain).unwrap_or_default();
                        rows.push((id, fields));
                    }
                }
            }
            (len, ("ID".to_string(), "フィールド".to_string()), rows)
        }
        other => (
            0,
            ("項目".to_string(), "値".to_string()),
            vec![(
                "型".to_string(),
                format!("{other} (このバージョンでは値プレビュー未対応)"),
            )],
        ),
    };

    // stringは先頭VALUE_PREVIEW_BYTESバイトまでしか読んでいない
    let truncated = if kv_type == "string" {
        total > VALUE_PREVIEW_BYTES as i64
    } else {
        (rows.len() as i64) < total
    };
    Ok(KvKeyDetail {
        key: key.to_string(),
        kv_type,
        ttl,
        memory,
        encoding,
        total,
        cols,
        rows,
        truncated,
    })
}

// ---------- 値の編集 ----------

/// 値ビューの1行 (1列目 = field / 2列目 = value)。
/// 型によって意味が変わる:
///   string → value のみ / hash → フィールド名と値 / list → indexと値
///   set → #とメンバー / zset → スコアとメンバー / stream → IDとフィールド
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvRow {
    pub field: String,
    pub value: String,
}

/// キーに対する変更内容
#[derive(Debug, Clone, Deserialize)]
// rename_all はバリアント名だけなので、中のフィールド名にも別途camelCaseを指定する
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum KvChange {
    /// 既存の要素を書き換える (beforeの行をafterの内容へ)
    Update {
        key: String,
        kv_type: String,
        before: KvRow,
        after: KvRow,
    },
    /// 要素を足す
    Insert {
        key: String,
        kv_type: String,
        row: KvRow,
    },
    /// 要素を1件消す
    Remove {
        key: String,
        kv_type: String,
        row: KvRow,
    },
    /// キーごと消す
    DeleteKey { key: String },
    /// キー名を変える
    Rename { key: String, new_key: String },
    /// TTLを設定する (0以下なら無期限に戻す)
    Expire { key: String, ttl: i64 },
    /// 新しいキーを作る
    CreateKey {
        key: String,
        kv_type: String,
        row: KvRow,
    },
}

/// listのindexとして読む
fn parse_index(s: &str) -> Result<i64, String> {
    s.trim()
        .parse::<i64>()
        .map_err(|_| format!("indexは整数で指定してください: {s}"))
}

/// zsetのスコアとして読む
fn parse_score(s: &str) -> Result<f64, String> {
    s.trim()
        .parse::<f64>()
        .map_err(|_| format!("スコアは数値で指定してください: {s}"))
}

/// キー名が空でないか確認する
fn check_key(key: &str) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("キー名を入力してください".into());
    }
    Ok(())
}

/// 変更を適用し、実行した内容の要約 (クエリログ用) を返す
pub async fn apply_change(
    conn: &mut MultiplexedConnection,
    change: &KvChange,
) -> Result<String, String> {
    match change {
        KvChange::Update {
            key,
            kv_type,
            before,
            after,
        } => {
            check_key(key)?;
            update_value(conn, key, kv_type, before, after).await
        }
        KvChange::Insert { key, kv_type, row } => {
            check_key(key)?;
            insert_value(conn, key, kv_type, row).await
        }
        KvChange::Remove { key, kv_type, row } => {
            check_key(key)?;
            remove_value(conn, key, kv_type, row).await
        }
        KvChange::DeleteKey { key } => {
            check_key(key)?;
            let n: i64 = redis::cmd("DEL")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            if n == 0 {
                return Err("キーが存在しません (すでに消えている可能性があります)".into());
            }
            Ok(format!("DEL {key}"))
        }
        KvChange::Rename { key, new_key } => {
            check_key(key)?;
            check_key(new_key)?;
            if key == new_key {
                return Err("キー名が変わっていません".into());
            }
            // 既存キーを上書きしないよう RENAMENX を使う
            let ok: i64 = redis::cmd("RENAMENX")
                .arg(key)
                .arg(new_key)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            if ok == 0 {
                return Err(format!("同じ名前のキーが既にあります: {new_key}"));
            }
            Ok(format!("RENAMENX {key} {new_key}"))
        }
        KvChange::Expire { key, ttl } => {
            check_key(key)?;
            if *ttl > 0 {
                let ok: i64 = redis::cmd("EXPIRE")
                    .arg(key)
                    .arg(*ttl)
                    .query_async(conn)
                    .await
                    .map_err(format_err)?;
                if ok == 0 {
                    return Err("キーが存在しません".into());
                }
                Ok(format!("EXPIRE {key} {ttl}"))
            } else {
                let _: i64 = redis::cmd("PERSIST")
                    .arg(key)
                    .query_async(conn)
                    .await
                    .map_err(format_err)?;
                Ok(format!("PERSIST {key}"))
            }
        }
        KvChange::CreateKey { key, kv_type, row } => {
            check_key(key)?;
            let exists: i64 = redis::cmd("EXISTS")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            if exists == 1 {
                return Err(format!("同じ名前のキーが既にあります: {key}"));
            }
            insert_value(conn, key, kv_type, row).await
        }
    }
}

/// 既存の要素を書き換える
async fn update_value(
    conn: &mut MultiplexedConnection,
    key: &str,
    kv_type: &str,
    before: &KvRow,
    after: &KvRow,
) -> Result<String, String> {
    match kv_type {
        "string" => {
            // SETはTTLを消してしまうため、KEEPTTLで期限を残す
            let _: () = redis::cmd("SET")
                .arg(key)
                .arg(&after.value)
                .arg("KEEPTTL")
                .query_async(conn)
                .await
                .map_err(format_err)?;
            Ok(format!("SET {key} <値> KEEPTTL"))
        }
        "hash" => {
            if before.field == after.field {
                let _: i64 = redis::cmd("HSET")
                    .arg(key)
                    .arg(&after.field)
                    .arg(&after.value)
                    .query_async(conn)
                    .await
                    .map_err(format_err)?;
                Ok(format!("HSET {key} {}", after.field))
            } else {
                // フィールド名の変更は「消して足す」ので、まとめて実行する
                let mut pipe = redis::pipe();
                pipe.atomic();
                pipe.cmd("HDEL").arg(key).arg(&before.field).ignore();
                pipe.cmd("HSET")
                    .arg(key)
                    .arg(&after.field)
                    .arg(&after.value)
                    .ignore();
                let _: () = pipe.query_async(conn).await.map_err(format_err)?;
                Ok(format!(
                    "HDEL {key} {} / HSET {key} {}",
                    before.field, after.field
                ))
            }
        }
        "list" => {
            let idx = parse_index(&before.field)?;
            // 位置は他の更新でずれるため、書き換える前に中身を確かめる
            let cur: Option<Vec<u8>> = redis::cmd("LINDEX")
                .arg(key)
                .arg(idx)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            match cur {
                Some(v) if bytes_to_display(&v) == before.value => {}
                Some(_) => {
                    return Err(
                        "この要素は他で更新されています。再読み込みしてからやり直してください"
                            .into(),
                    )
                }
                None => return Err("対象の要素が見つかりません".into()),
            }
            let _: () = redis::cmd("LSET")
                .arg(key)
                .arg(idx)
                .arg(&after.value)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            Ok(format!("LSET {key} {idx}"))
        }
        "set" => {
            if before.value == after.value {
                return Err("値が変わっていません".into());
            }
            let mut pipe = redis::pipe();
            pipe.atomic();
            pipe.cmd("SREM").arg(key).arg(&before.value).ignore();
            pipe.cmd("SADD").arg(key).arg(&after.value).ignore();
            let _: () = pipe.query_async(conn).await.map_err(format_err)?;
            Ok(format!("SREM {key} <旧> / SADD {key} <新>"))
        }
        "zset" => {
            let score = parse_score(&after.field)?;
            if before.value == after.value {
                // スコアだけの変更はZADDで上書きできる
                let _: i64 = redis::cmd("ZADD")
                    .arg(key)
                    .arg(score)
                    .arg(&after.value)
                    .query_async(conn)
                    .await
                    .map_err(format_err)?;
                Ok(format!("ZADD {key} {score} <メンバー>"))
            } else {
                let mut pipe = redis::pipe();
                pipe.atomic();
                pipe.cmd("ZREM").arg(key).arg(&before.value).ignore();
                pipe.cmd("ZADD")
                    .arg(key)
                    .arg(score)
                    .arg(&after.value)
                    .ignore();
                let _: () = pipe.query_async(conn).await.map_err(format_err)?;
                Ok(format!("ZREM {key} <旧> / ZADD {key} {score} <新>"))
            }
        }
        "stream" => {
            Err("streamの既存エントリは仕様上変更できません (追加と削除のみ可能です)".into())
        }
        other => Err(format!("{other} 型の編集には対応していません")),
    }
}

/// 要素を足す (新規キー作成でも使う)
async fn insert_value(
    conn: &mut MultiplexedConnection,
    key: &str,
    kv_type: &str,
    row: &KvRow,
) -> Result<String, String> {
    match kv_type {
        "string" => {
            let _: () = redis::cmd("SET")
                .arg(key)
                .arg(&row.value)
                .arg("KEEPTTL")
                .query_async(conn)
                .await
                .map_err(format_err)?;
            Ok(format!("SET {key} <値> KEEPTTL"))
        }
        "hash" => {
            if row.field.trim().is_empty() {
                return Err("フィールド名を入力してください".into());
            }
            let _: i64 = redis::cmd("HSET")
                .arg(key)
                .arg(&row.field)
                .arg(&row.value)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            Ok(format!("HSET {key} {}", row.field))
        }
        "list" => {
            let _: i64 = redis::cmd("RPUSH")
                .arg(key)
                .arg(&row.value)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            Ok(format!("RPUSH {key} <値>"))
        }
        "set" => {
            let n: i64 = redis::cmd("SADD")
                .arg(key)
                .arg(&row.value)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            if n == 0 {
                return Err("同じメンバーが既にあります".into());
            }
            Ok(format!("SADD {key} <メンバー>"))
        }
        "zset" => {
            let score = parse_score(&row.field)?;
            let _: i64 = redis::cmd("ZADD")
                .arg(key)
                .arg(score)
                .arg(&row.value)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            Ok(format!("ZADD {key} {score} <メンバー>"))
        }
        "stream" => {
            if row.field.trim().is_empty() {
                return Err("フィールド名を入力してください".into());
            }
            let id: String = redis::cmd("XADD")
                .arg(key)
                .arg("*")
                .arg(&row.field)
                .arg(&row.value)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            Ok(format!("XADD {key} * {} (ID: {id})", row.field))
        }
        other => Err(format!("{other} 型の追加には対応していません")),
    }
}

/// 要素を1件消す
async fn remove_value(
    conn: &mut MultiplexedConnection,
    key: &str,
    kv_type: &str,
    row: &KvRow,
) -> Result<String, String> {
    match kv_type {
        "string" => Err("string型は値だけを消せません。キーごと削除してください".into()),
        "hash" => {
            let n: i64 = redis::cmd("HDEL")
                .arg(key)
                .arg(&row.field)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            if n == 0 {
                return Err("対象のフィールドが見つかりません".into());
            }
            Ok(format!("HDEL {key} {}", row.field))
        }
        "list" => {
            // indexではなく値で消す (同じ値が複数あれば先頭の1件)
            let n: i64 = redis::cmd("LREM")
                .arg(key)
                .arg(1)
                .arg(&row.value)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            if n == 0 {
                return Err("対象の要素が見つかりません".into());
            }
            Ok(format!("LREM {key} 1 <値>"))
        }
        "set" => {
            let n: i64 = redis::cmd("SREM")
                .arg(key)
                .arg(&row.value)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            if n == 0 {
                return Err("対象のメンバーが見つかりません".into());
            }
            Ok(format!("SREM {key} <メンバー>"))
        }
        "zset" => {
            let n: i64 = redis::cmd("ZREM")
                .arg(key)
                .arg(&row.value)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            if n == 0 {
                return Err("対象のメンバーが見つかりません".into());
            }
            Ok(format!("ZREM {key} <メンバー>"))
        }
        "stream" => {
            let n: i64 = redis::cmd("XDEL")
                .arg(key)
                .arg(&row.field)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            if n == 0 {
                return Err("対象のエントリが見つかりません".into());
            }
            Ok(format!("XDEL {key} {}", row.field))
        }
        other => Err(format!("{other} 型の削除には対応していません")),
    }
}

// ---------- コマンド実行 (コンソール) ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvStatementResult {
    pub command: String,
    /// redis-cli風の整形済み出力
    pub lines: Vec<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvRunOutput {
    pub statements: Vec<KvStatementResult>,
    pub error: Option<String>,
    pub failed_index: Option<usize>,
}

/// 接続を占有・破壊するため実行を拒否するコマンド
const BLOCKED_COMMANDS: &[&str] = &["MONITOR", "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE"];

/// 実行前に確認したい破壊的なコマンド。
/// 取り消せない・サーバー全体に影響するもの
const DESTRUCTIVE_COMMANDS: &[&str] = &[
    "FLUSHALL", "FLUSHDB", "SHUTDOWN", "REPLICAOF", "SLAVEOF", "SWAPDB", "RESET",
    "FAILOVER", "MIGRATE", "DEBUG", "DEL", "UNLINK", "RENAME", "GETDEL",
    // スクリプトは中で何でも実行できるため、_RO 版以外は確認の対象にする
    "EVAL", "EVALSHA", "FCALL",
];

/// 壊しはしないが、サーバーを詰まらせる可能性があるため確認したいコマンド
const HEAVY_COMMANDS: &[&str] = &[
    "KEYS",
    // LCS は2つの文字列の長さの積だけ計算する (数MB同士だとサーバーが数秒止まる)
    "LCS",
];

/// サブコマンドまで見て判断する破壊的なコマンド
const DESTRUCTIVE_SUBCOMMANDS: &[(&str, &[&str])] = &[
    ("CONFIG", &["SET", "REWRITE", "RESETSTAT"]),
    ("ACL", &["SETUSER", "DELUSER", "LOAD", "SAVE"]),
    ("CLIENT", &["KILL", "PAUSE", "UNPAUSE", "NO-EVICT"]),
    ("SCRIPT", &["FLUSH"]),
    ("FUNCTION", &["FLUSH", "DELETE", "RESTORE"]),
    ("CLUSTER", &["RESET", "FORGET", "FAILOVER", "SETSLOT", "ADDSLOTS", "DELSLOTS"]),
    ("XGROUP", &["DESTROY"]),
    ("LATENCY", &["RESET"]),
    ("SLOWLOG", &["RESET"]),
];

/// 確認が要るコマンドなら、確認画面に出す表示名を返す (例: "CONFIG SET")
pub fn destructive_command(args: &[String]) -> Option<String> {
    let name = args.first()?.to_uppercase();
    if DESTRUCTIVE_COMMANDS.contains(&name.as_str()) || HEAVY_COMMANDS.contains(&name.as_str()) {
        return Some(name);
    }
    let sub = args.get(1)?.to_uppercase();
    DESTRUCTIVE_SUBCOMMANDS
        .iter()
        .find(|(c, subs)| *c == name && subs.contains(&sub.as_str()))
        .map(|_| format!("{name} {sub}"))
}

/// 取り消せない操作か (重いだけのものと文言を分けるために使う)
fn is_irreversible(shown: &str) -> bool {
    !HEAVY_COMMANDS.contains(&shown)
}

/// 確認が要るコマンドを全て返す (1つ確認したら他も素通り、とならないように)
pub fn find_destructive(commands: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in commands {
        if let Some(c) = destructive_command(&split_args(line)) {
            if !out.contains(&c) {
                out.push(c);
            }
        }
    }
    out
}

/// 値を変えないコマンド (読み取り専用の接続で許可する)。
/// 一覧に無いものは変更する可能性があるものとして拒否する
const READ_ONLY_COMMANDS: &[&str] = &[
    "GET", "MGET", "GETRANGE", "STRLEN", "SUBSTR", "EXISTS", "TYPE", "TTL", "PTTL",
    "EXPIRETIME", "PEXPIRETIME", "KEYS", "SCAN", "RANDOMKEY", "DBSIZE", "DUMP",
    "HGET", "HMGET", "HGETALL", "HKEYS", "HVALS", "HLEN", "HEXISTS", "HSTRLEN", "HSCAN",
    "HRANDFIELD", "LRANGE", "LLEN", "LINDEX", "LPOS", "SMEMBERS", "SCARD", "SISMEMBER",
    "SMISMEMBER", "SRANDMEMBER", "SSCAN", "SDIFF", "SINTER", "SUNION", "SINTERCARD",
    "ZRANGE", "ZRANGEBYSCORE", "ZRANGEBYLEX", "ZREVRANGE", "ZREVRANGEBYSCORE", "ZCARD",
    "ZCOUNT", "ZSCORE", "ZMSCORE", "ZRANK", "ZREVRANK", "ZSCAN", "ZLEXCOUNT", "ZRANDMEMBER",
    "XRANGE", "XREVRANGE", "XLEN", "XPENDING", "BITCOUNT", "BITPOS", "GETBIT", "BITFIELD_RO",
    "PFCOUNT", "GEOPOS", "GEODIST", "GEOSEARCH", "GEOHASH", "GEORADIUS_RO",
    "GEORADIUSBYMEMBER_RO", "SORT_RO", "EVAL_RO", "EVALSHA_RO", "FCALL_RO",
    // 集合演算のうち、結果を書き戻さない方 (…STORE は別コマンドなので入らない)
    "ZDIFF", "ZUNION", "ZINTER", "ZINTERCARD", "LCS",
    // ハッシュのフィールド単位のTTL (設定する HEXPIRE / HPERSIST は入らない)
    "HTTL", "HPTTL", "HEXPIRETIME", "HPEXPIRETIME",
    "LOLWUT", "INFO", "PING", "ECHO", "TIME",
];

/// サブコマンドまで見ないと判断できないもの (許可するサブコマンドの一覧)。
/// 例: CLIENT LIST は参照だが、CLIENT KILL は他の接続を切ってしまう
const READ_ONLY_SUBCOMMANDS: &[(&str, &[&str])] = &[
    ("CLIENT", &["LIST", "INFO", "ID", "GETNAME"]),
    /*
     * ACL GETUSER はパスワードのハッシュを返すため、読むだけでも通さない。
     * ACL LIST も定義を返すが、こちらはハッシュを `#…` として伏せた形になる
     */
    ("ACL", &["LIST", "CAT", "WHOAMI", "USERS"]),
    ("OBJECT", &["ENCODING", "FREQ", "IDLETIME", "REFCOUNT", "HELP"]),
    ("MEMORY", &["USAGE", "STATS", "DOCTOR", "HELP"]),
    ("SLOWLOG", &["GET", "LEN", "HELP"]),
    ("LATENCY", &["LATEST", "HISTORY", "DOCTOR", "HELP"]),
    ("XINFO", &["STREAM", "GROUPS", "CONSUMERS", "HELP"]),
    ("COMMAND", &["COUNT", "DOCS", "INFO", "GETKEYS", "LIST", "HELP"]),
    ("CONFIG", &["GET"]),
    ("SCRIPT", &["EXISTS", "HELP"]),
    ("FUNCTION", &["LIST", "DUMP", "STATS", "HELP"]),
    ("PUBSUB", &["CHANNELS", "NUMSUB", "NUMPAT", "SHARDCHANNELS", "SHARDNUMSUB", "HELP"]),
    (
        "CLUSTER",
        &[
            "INFO",
            "MYID",
            "SLOTS",
            "SHARDS",
            "NODES",
            "LINKS",
            "KEYSLOT",
            "COUNTKEYSINSLOT",
            "GETKEYSINSLOT",
            "COUNT-FAILURE-REPORTS",
            "HELP",
        ],
    ),
];

/// 読み取り専用の接続で実行してよいコマンドか (サブコマンドまで見る)
pub fn is_read_only_command(args: &[String]) -> bool {
    let Some(name) = args.first() else {
        return false;
    };
    let name = name.to_uppercase();
    if let Some((_, subs)) = READ_ONLY_SUBCOMMANDS.iter().find(|(n, _)| *n == name) {
        return args
            .get(1)
            .is_some_and(|s| subs.contains(&s.to_uppercase().as_str()));
    }
    READ_ONLY_COMMANDS.contains(&name.as_str())
}

/// コマンド行を引数に分割する (ダブル/シングルクォート対応)
fn split_args(line: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut chars = line.chars().peekable();
    let mut has_token = false;
    while let Some(c) = chars.next() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else if c == '\\' && q == '"' {
                    // ダブルクォート内のエスケープ (\" \\ \n \t)
                    match chars.next() {
                        Some('n') => cur.push('\n'),
                        Some('t') => cur.push('\t'),
                        Some(other) => cur.push(other),
                        None => {}
                    }
                } else {
                    cur.push(c);
                }
            }
            None => match c {
                '"' | '\'' => {
                    quote = Some(c);
                    has_token = true;
                }
                c if c.is_whitespace() => {
                    if has_token {
                        args.push(std::mem::take(&mut cur));
                        has_token = false;
                    }
                }
                _ => {
                    cur.push(c);
                    has_token = true;
                }
            },
        }
    }
    if has_token {
        args.push(cur);
    }
    args
}

/// redis::Value を素の文字列にする (単純値向け)
fn value_to_plain(v: &redis::Value) -> String {
    match v {
        redis::Value::Nil => String::new(),
        redis::Value::Int(n) => n.to_string(),
        redis::Value::Okay => "OK".to_string(),
        redis::Value::SimpleString(s) => s.clone(),
        redis::Value::BulkString(b) => String::from_utf8_lossy(b).to_string(),
        redis::Value::Array(items) => items
            .iter()
            .map(value_to_plain)
            .collect::<Vec<_>>()
            .join(" "),
        other => format!("{other:?}"),
    }
}

/// バイト列を、切り詰めずに文字として読む。
///
/// 検索の照合に使う。表示用の `bytes_to_display` は途中で切って
/// 「… (Nバイト)」を足すので、そのまま照合に使うと
/// 切れた先が見えないうえ、足した文字まで検索に引っかかってしまう
pub(crate) fn bytes_to_text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).to_string()
}

/// バイト列を表示用文字列にする (バイナリはhex表記、長すぎる場合は省略)
pub(crate) fn bytes_to_display(b: &[u8]) -> String {
    match std::str::from_utf8(b) {
        Ok(s) => {
            if s.len() > VALUE_PREVIEW_BYTES {
                format!("{}… ({}バイト)", &s[..floor_char(s, VALUE_PREVIEW_BYTES)], b.len())
            } else {
                s.to_string()
            }
        }
        Err(_) => {
            let head: Vec<String> = b.iter().take(64).map(|x| format!("{x:02x}")).collect();
            format!(
                "(バイナリ {}バイト) {}{}",
                b.len(),
                head.join(" "),
                if b.len() > 64 { " …" } else { "" }
            )
        }
    }
}

/// 文字境界でVALUE_PREVIEW_BYTES以下に切り詰める位置を返す
fn floor_char(s: &str, max: usize) -> usize {
    let mut i = max.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// 値そのものが資格情報になる設定名。
///
/// `CONFIG GET requirepass` はパスワードをそのまま返す。
/// 読み取り専用は「安全に渡せる接続」のつもりで使われるので、
/// 参照はできても中身は見せない
const SECRET_CONFIGS: &[&str] = &[
    "requirepass",
    // Valkey 8 で primary… も別名として使える
    "masterauth",
    "primaryauth",
    "tls-key-file-pass",
    "tls-client-key-file-pass",
];

/// 伏せたことが分かる文言 (空欄と区別できるようにする)
const MASKED_CONFIG: &str = "(値は伏せています)";

fn is_secret_config(name: &str) -> bool {
    SECRET_CONFIGS.iter().any(|s| name.eq_ignore_ascii_case(s))
}

/**
 * クエリログに残す前に、コマンドの中の資格情報を伏せる。
 *
 * `AUTH <パスワード>` や `CONFIG SET requirepass <パスワード>` を
 * そのまま記録すると、コンソールの履歴と、その書き出しファイルに
 * パスワードが平文で残ってしまう。
 * 応答側 (`CONFIG GET requirepass`) は既に伏せているので、要求側もそろえる
 */
pub fn mask_secrets(line: &str) -> String {
    let args = split_args(line);
    let Some(name) = args.first() else {
        return line.to_string();
    };
    // 何番目の引数から先を伏せるか (伏せる必要が無ければ None)
    let from = if name.eq_ignore_ascii_case("AUTH") {
        // AUTH <パスワード> / AUTH <ユーザー> <パスワード>
        Some(args.len().saturating_sub(1).max(1))
    } else if args.len() >= 4
        && name.eq_ignore_ascii_case("CONFIG")
        && args[1].eq_ignore_ascii_case("SET")
        && is_secret_config(&args[2])
    {
        Some(3)
    } else if args.len() >= 3 && name.eq_ignore_ascii_case("ACL") {
        // ACL SETUSER <ユーザー> ... の中にパスワード (>pw / #ハッシュ) が混ざる
        if args[1].eq_ignore_ascii_case("SETUSER") {
            Some(3)
        } else {
            None
        }
    } else {
        None
    };
    match from {
        None => line.to_string(),
        Some(at) => {
            let mut out: Vec<String> = args.iter().take(at).cloned().collect();
            if args.len() > at {
                out.push(MASKED_CONFIG.to_string());
            }
            out.join(" ")
        }
    }
}

/// `CONFIG GET` かどうか
fn is_config_get(args: &[String]) -> bool {
    args.len() >= 2
        && args[0].eq_ignore_ascii_case("CONFIG")
        && args[1].eq_ignore_ascii_case("GET")
}

/// 文字列として読める値なら取り出す (設定名の照合に使う)
fn value_str(v: &redis::Value) -> Option<String> {
    match v {
        redis::Value::BulkString(b) => Some(String::from_utf8_lossy(b).to_string()),
        redis::Value::SimpleString(s) => Some(s.clone()),
        _ => None,
    }
}

/// 設定値のうち、資格情報になるものを伏せる。
///
/// 値が空のときは伏せない。「パスワードが設定されていない」こと自体は
/// 運用上知りたい情報で、伏せると分からなくなる
fn mask_config_value(name: &redis::Value, value: redis::Value) -> redis::Value {
    let secret = value_str(name).is_some_and(|n| is_secret_config(&n));
    let empty = value_str(&value).is_some_and(|v| v.is_empty());
    if secret && !empty {
        redis::Value::BulkString(MASKED_CONFIG.as_bytes().to_vec())
    } else {
        value
    }
}

/// `CONFIG GET` の応答から資格情報を伏せる。
///
/// `CONFIG GET *` や `CONFIG GET requirepa*` のようにパターンで
/// まとめて取れるため、要求した名前ではなく**返ってきた名前**を見る。
/// RESP2は「名前, 値, 名前, 値…」の並び、RESP3は連想配列で返る
fn mask_config_reply(v: redis::Value) -> redis::Value {
    match v {
        redis::Value::Array(items) => {
            let mut out: Vec<redis::Value> = Vec::with_capacity(items.len());
            let mut it = items.into_iter();
            while let Some(name) = it.next() {
                match it.next() {
                    Some(value) => {
                        let masked = mask_config_value(&name, value);
                        out.push(name);
                        out.push(masked);
                    }
                    // 対になっていない末尾はそのまま返す (想定外の形)
                    None => out.push(name),
                }
            }
            redis::Value::Array(out)
        }
        redis::Value::Map(pairs) => redis::Value::Map(
            pairs
                .into_iter()
                .map(|(name, value)| {
                    let masked = mask_config_value(&name, value);
                    (name, masked)
                })
                .collect(),
        ),
        other => other,
    }
}

/// redis-cli風に整形する
fn format_value(v: &redis::Value, out: &mut Vec<String>, prefix: &str) {
    match v {
        redis::Value::Nil => out.push(format!("{prefix}(nil)")),
        redis::Value::Int(n) => out.push(format!("{prefix}(integer) {n}")),
        redis::Value::Okay => out.push(format!("{prefix}OK")),
        redis::Value::SimpleString(s) => out.push(format!("{prefix}{s}")),
        redis::Value::BulkString(b) => {
            let text = bytes_to_display(b);
            out.push(format!("{prefix}\"{}\"", text.replace('\n', "\\n")));
        }
        redis::Value::Array(items) => {
            if items.is_empty() {
                out.push(format!("{prefix}(empty array)"));
                return;
            }
            let width = items.len().to_string().len();
            for (i, item) in items.iter().enumerate() {
                let head = format!("{prefix}{:>width$}) ", i + 1, width = width);
                let indent = " ".repeat(head.len());
                let mut sub = Vec::new();
                format_value(item, &mut sub, "");
                for (j, line) in sub.iter().enumerate() {
                    if j == 0 {
                        out.push(format!("{head}{line}"));
                    } else {
                        out.push(format!("{indent}{line}"));
                    }
                }
            }
        }
        other => out.push(format!("{prefix}{other:?}")),
    }
}

/// コマンド行 (複数行) を逐次実行する。エラーで停止し、途中までの結果を返す
pub async fn exec(
    conn: &mut MultiplexedConnection,
    commands: &[String],
    read_only: bool,
    confirmed: bool,
) -> Result<KvRunOutput, String> {
    let mut statements = Vec::new();
    for (i, line) in commands.iter().enumerate() {
        let args = split_args(line);
        let Some(name) = args.first() else { continue };
        let upper = name.to_uppercase();
        let err_at = |msg: String| KvRunOutput {
            statements: Vec::new(),
            error: Some(if commands.len() == 1 {
                msg.clone()
            } else {
                format!("{}行目でエラー: {msg}", i + 1)
            }),
            failed_index: Some(i),
        };
        if BLOCKED_COMMANDS.contains(&upper.as_str()) {
            let mut out = err_at(format!(
                "{upper} は接続を占有するためこのコンソールでは実行できません"
            ));
            out.statements = statements;
            return Ok(out);
        }
        if read_only && !is_read_only_command(&args) {
            // CLIENT KILL のようにサブコマンドまで含めて示す
            let shown = args
                .iter()
                .take(2)
                .map(|a| a.to_uppercase())
                .collect::<Vec<_>>()
                .join(" ");
            let mut out = err_at(format!(
                "この接続は読み取り専用です。{shown} は値を変える可能性があるため実行できません"
            ));
            out.statements = statements;
            return Ok(out);
        }
        // 取り消せない操作・重い操作は、画面で確認を経ていなければ実行しない
        // (複数行に紛れていても1行ずつ見るので素通りしない)
        if !confirmed {
            if let Some(cmd) = destructive_command(&args) {
                let mut out = err_at(if is_irreversible(&cmd) {
                    format!("{cmd} は取り消せない操作です。実行前の確認が必要です")
                } else {
                    format!("{cmd} はサーバーを詰まらせることがあります。実行前の確認が必要です")
                });
                out.statements = statements;
                return Ok(out);
            }
        }
        if upper == "SELECT" {
            let mut out = err_at(
                "SELECT はツールバーのDB選択から切り替えてください".to_string(),
            );
            out.statements = statements;
            return Ok(out);
        }

        let mut cmd = redis::cmd(name);
        for a in &args[1..] {
            cmd.arg(a);
        }
        let started = std::time::Instant::now();
        let res: Result<redis::Value, _> =
            match timeout(EXEC_TIMEOUT, cmd.query_async(conn)).await {
                Ok(r) => r.map_err(format_err),
                Err(_) => Err("コマンドがタイムアウトしました (60秒)".to_string()),
            };
        match res {
            Ok(v) => {
                // 読み取り専用では、設定値に混ざる資格情報を伏せる
                let v = if read_only && is_config_get(&args) {
                    mask_config_reply(v)
                } else {
                    v
                };
                let mut lines = Vec::new();
                format_value(&v, &mut lines, "");
                statements.push(KvStatementResult {
                    command: line.clone(),
                    lines,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                });
            }
            Err(e) => {
                let mut out = err_at(e);
                out.statements = statements;
                return Ok(out);
            }
        }
    }
    Ok(KvRunOutput {
        statements,
        error: None,
        failed_index: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(line: &str) -> bool {
        is_read_only_command(&split_args(line))
    }

    #[test]
    fn 参照だけのコマンドは通す() {
        for cmd in [
            "GET k", "SCAN 0", "TYPE k", "TTL k", "HGETALL h", "LRANGE l 0 -1",
            // 集合演算は、結果を書き戻さない方だけ
            "ZDIFF 2 a b", "ZUNION 2 a b", "ZINTER 2 a b", "ZINTERCARD 2 a b",
            "LCS a b",
            // ハッシュのフィールドTTLは、読む方だけ
            "HTTL h FIELDS 1 f", "HPEXPIRETIME h FIELDS 1 f",
        ] {
            assert!(ok(cmd), "{cmd}");
        }
    }

    #[test]
    fn 書き込むコマンドは断る() {
        for cmd in [
            "SET k v", "DEL k", "FLUSHALL", "ZDIFFSTORE d 2 a b", "ZUNIONSTORE d 2 a b",
            // 期限を付けるものは書き込み
            "HEXPIRE h 60 FIELDS 1 f", "HPERSIST h FIELDS 1 f", "GETEX k", "GETDEL k",
            // 取り出しつつ所有権を移すもの
            "XAUTOCLAIM s g c 0 0", "XCLAIM s g c 0 1-1",
        ] {
            assert!(!ok(cmd), "{cmd}");
        }
    }

    fn bulk(s: &str) -> redis::Value {
        redis::Value::BulkString(s.as_bytes().to_vec())
    }

    /// CONFIG GET の応答 (RESP2の「名前, 値」の並び) を作る
    fn config_reply(pairs: &[(&str, &str)]) -> redis::Value {
        redis::Value::Array(
            pairs
                .iter()
                .flat_map(|(k, v)| [bulk(k), bulk(v)])
                .collect(),
        )
    }

    fn plain(v: &redis::Value) -> String {
        value_to_plain(v)
    }

    #[test]
    fn 設定値の資格情報は伏せる() {
        let got = mask_config_reply(config_reply(&[
            ("maxmemory", "0"),
            ("requirepass", "hunter2"),
            ("masterauth", "s3cret"),
            ("primaryauth", "s3cret"),
            ("tls-key-file-pass", "pw"),
            ("tls-client-key-file-pass", "pw"),
            ("appendonly", "yes"),
        ]));
        let text = plain(&got);
        // 資格情報は出さない
        for secret in ["hunter2", "s3cret", "pw"] {
            assert!(!text.contains(secret), "{text}");
        }
        // 設定名と、資格情報でない値はそのまま
        for keep in ["maxmemory", "0", "appendonly", "yes", "requirepass"] {
            assert!(text.contains(keep), "{text}");
        }
        assert!(text.contains(MASKED_CONFIG));
    }

    #[test]
    fn 設定されていないパスワードは伏せない() {
        // 「認証が掛かっていない」ことは運用上知りたい情報なので、空欄は空欄のまま
        let got = mask_config_reply(config_reply(&[("requirepass", "")]));
        assert!(!plain(&got).contains(MASKED_CONFIG));
    }

    #[test]
    fn 大文字小文字とパターン取得でも伏せる() {
        // CONFIG GET * は名前がサーバーの表記で返るため、返ってきた名前で見る
        let got = mask_config_reply(config_reply(&[("RequirePass", "hunter2")]));
        assert!(!plain(&got).contains("hunter2"));

        // 応答が連想配列 (RESP3) でも同じ
        let got = mask_config_reply(redis::Value::Map(vec![(
            bulk("requirepass"),
            bulk("hunter2"),
        )]));
        assert!(!plain(&got).contains("hunter2"));
    }

    #[test]
    fn 設定を読むコマンド自体は通す() {
        // 伏せるだけで、CONFIG GET を断りはしない (maxmemory 等は見たい)
        assert!(ok("CONFIG GET maxmemory"));
        assert!(is_config_get(&split_args("config get *")));
        assert!(!is_config_get(&split_args("CONFIG SET maxmemory 0")));
        assert!(!is_config_get(&split_args("GET config")));
    }

    #[test]
    fn 資格情報が読めるコマンドは通さない() {
        // 読み取り専用でも、パスワードのハッシュまで見せる必要はない
        assert!(!ok("ACL GETUSER default"));
        assert!(!ok("acl getuser default"));
    }

    #[test]
    fn サブコマンドまで見る() {
        assert!(ok("CLIENT LIST"));
        assert!(!ok("CLIENT KILL ID 1"));
        assert!(!ok("ACL SETUSER x"));
        assert!(ok("ACL WHOAMI"));
        assert!(ok("SCRIPT EXISTS abc"));
        assert!(!ok("SCRIPT FLUSH"));
        assert!(ok("FUNCTION LIST"));
        assert!(!ok("FUNCTION FLUSH"));
        assert!(ok("PUBSUB CHANNELS"));
        assert!(ok("CLUSTER INFO"));
        assert!(!ok("CLUSTER FORGET x"));
        assert!(ok("CONFIG GET maxmemory"));
        assert!(!ok("CONFIG SET maxmemory 0"));
        // サブコマンドが無ければ通さない
        assert!(!ok("CLIENT"));
        assert!(!ok("CONFIG"));
    }

    #[test]
    fn 大文字小文字は区別しない() {
        assert!(ok("get k"));
        assert!(ok("client list"));
        assert!(!ok("set k v"));
    }

    #[test]
    fn 認証コマンドのパスワードを伏せる() {
        assert_eq!(mask_secrets("AUTH hunter2"), "AUTH (値は伏せています)");
        assert_eq!(
            mask_secrets("auth alice hunter2"),
            "auth alice (値は伏せています)"
        );
        // 引数が無ければそのまま (伏せるものが無い)
        assert_eq!(mask_secrets("AUTH"), "AUTH");
    }

    #[test]
    fn 設定のパスワードを伏せる() {
        assert_eq!(
            mask_secrets("CONFIG SET requirepass hunter2"),
            "CONFIG SET requirepass (値は伏せています)"
        );
        assert_eq!(
            mask_secrets("config set masterauth hunter2"),
            "config set masterauth (値は伏せています)"
        );
        // 秘密でない設定は読めるままにする (何をしたか分からなくなるため)
        assert_eq!(
            mask_secrets("CONFIG SET maxmemory 100mb"),
            "CONFIG SET maxmemory 100mb"
        );
        assert_eq!(
            mask_secrets("CONFIG GET requirepass"),
            "CONFIG GET requirepass"
        );
    }

    #[test]
    fn aclのパスワード指定を伏せる() {
        assert_eq!(
            mask_secrets("ACL SETUSER alice on >hunter2 ~* +@all"),
            "ACL SETUSER alice (値は伏せています)"
        );
        // 参照系はそのまま
        assert_eq!(mask_secrets("ACL LIST"), "ACL LIST");
        assert_eq!(mask_secrets("ACL WHOAMI"), "ACL WHOAMI");
    }

    #[test]
    fn 普通のコマンドは変えない() {
        for line in ["GET k", "SET k v", "DEL a b c", ""] {
            assert_eq!(mask_secrets(line), line);
        }
    }
}
