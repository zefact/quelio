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
    .map_err(|_| "Valkey接続がタイムアウトしました".to_string())?
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
            let kv_type = vals
                .get(i * 2)
                .map(|v| value_to_plain(v))
                .unwrap_or_default();
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

/// バイト列を表示用文字列にする (バイナリはhex表記、長すぎる場合は省略)
fn bytes_to_display(b: &[u8]) -> String {
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
