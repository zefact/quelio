//! Valkey: パターンに一致するキーの一括削除と、値からキーを探す検索。
//!
//! どちらも件数が読めないため、SCANで少しずつ進めながら
//! 進捗を出し、途中で止められるようにしてある。
//!
//! 削除は取り消せないので、消す前に必ず件数を数える手順を用意している

use redis::aio::MultiplexedConnection;
use serde::{Deserialize, Serialize};

use crate::csv_job::CsvJob;
use crate::kv::{bytes_to_text, format_err, SCAN_COUNT};

/// 一度に消す本数 (1回のUNLINKに渡す数)
const DELETE_BATCH: usize = 500;

/// 数えるときに名前も返す件数 (確認画面に出す見本)
const SAMPLE_KEYS: usize = 20;

/// 検索で返す最大件数
const SEARCH_LIMIT: usize = 500;

/// 1つのキーから読む要素の上限
const ELEMENT_LIMIT: usize = 1000;

/// 1つのキーの中を読むときにSCANを回す回数の上限
const ELEMENT_PAGES: usize = 1000;

/// 文字列型のキーから読むバイト数の上限
const STRING_BYTES: usize = 64 * 1024;

/// 一致した箇所のプレビューの長さ (文字数)
const PREVIEW_CHARS: usize = 200;

/// 読み進めるキーの上限 (終わらない検索・削除にしないための歯止め)
const MAX_SCANNED: usize = 500_000;

/// SCANを回す回数の上限。
///
/// 絞り込んだパターンでは一致するキーが増えないので、
/// 「一致した数」だけを見ていると巨大なDBで延々と回り続けてしまう
const MAX_PAGES: usize = 200_000;

/// 数えた結果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvCountResult {
    /// 一致したキーの数
    pub total: usize,
    /// 先頭いくつかのキー名 (確認画面に出す)
    pub sample: Vec<String>,
    pub cancelled: bool,
    /// 上限まで読んだので、まだ先がある
    pub truncated: bool,
}

/// 一括削除の結果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvDeleteResult {
    /// 消したキーの数
    pub deleted: usize,
    pub cancelled: bool,
    pub truncated: bool,
}

/// 検索の当たり
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvSearchHit {
    pub key: String,
    #[serde(rename = "type")]
    pub kv_type: String,
    /// 当たった場所 (hashのフィールド名・listの位置など。無ければ空)
    pub field: String,
    /// 当たった値の先頭
    pub preview: String,
}

/// 検索の結果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvSearchResult {
    pub hits: Vec<KvSearchHit>,
    /// 見に行ったキーの数
    pub scanned: usize,
    pub cancelled: bool,
    /// 上限に達して打ち切った
    pub truncated: bool,
}

/// 検索の条件
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvSearchOptions {
    /// 探す文字列
    pub needle: String,
    /// 大文字小文字を区別しない
    pub ignore_case: bool,
    /// キー名も探す対象にする
    pub include_keys: bool,
}

/// パターンとして受け付けるか。
///
/// 空のパターンは `*` と同じ意味になってしまうので断る。
/// 全件に当たる `*` は、呼び出し側がそれと分かって指定したときだけ通す
pub fn check_pattern(pattern: &str, allow_all: bool) -> Result<(), String> {
    let p = pattern.trim();
    if p.is_empty() {
        return Err("パターンを入力してください".into());
    }
    /*
     * `*` だけでなく `**` や `?*` も、ほぼすべてのキーに当たる。
     * 文字が1つも入っていないパターンはまとめて「全件」として扱う
     */
    if p.chars().all(|c| c == '*' || c == '?') && !allow_all {
        return Err(
            "ほぼすべてのキーが対象になります。実行するには確認してください".into(),
        );
    }
    Ok(())
}

/// SCANで1ページ読む
async fn scan_page(
    conn: &mut MultiplexedConnection,
    pattern: &str,
    cursor: &str,
) -> Result<(String, Vec<Vec<u8>>), String> {
    redis::cmd("SCAN")
        .arg(cursor)
        .arg("MATCH")
        .arg(pattern)
        .arg("COUNT")
        .arg(SCAN_COUNT)
        .query_async(conn)
        .await
        .map_err(format_err)
}

/// 一致するキーを数える (消す前の確認用。消しはしない)
pub async fn count_keys(
    conn: &mut MultiplexedConnection,
    pattern: &str,
    job: Option<&CsvJob>,
) -> Result<KvCountResult, String> {
    let pattern = pattern.trim();
    let mut cursor = "0".to_string();
    /*
     * SCANは同じキーを2回以上返すことがある (途中でテーブルが作り直されたとき)。
     * 消す件数の確認に使う数なので、取り除いて数える
     */
    let mut seen: std::collections::HashSet<Vec<u8>> = std::collections::HashSet::new();
    let mut sample: Vec<String> = Vec::new();
    let mut pages = 0usize;
    loop {
        if job.is_some_and(|j| j.is_cancelled()) {
            return Ok(KvCountResult {
                total: seen.len(),
                sample,
                cancelled: true,
                truncated: false,
            });
        }
        let (next, keys) = scan_page(conn, pattern, &cursor).await?;
        pages += 1;
        for k in keys {
            let show = sample.len() < SAMPLE_KEYS;
            let name = show.then(|| String::from_utf8_lossy(&k).to_string());
            if seen.insert(k) {
                if let Some(name) = name {
                    sample.push(name);
                }
            }
        }
        if let Some(j) = job {
            j.set_rows(seen.len());
        }
        cursor = next;
        if cursor == "0" {
            break;
        }
        if seen.len() >= MAX_SCANNED || pages >= MAX_PAGES {
            return Ok(KvCountResult {
                total: seen.len(),
                sample,
                cancelled: false,
                truncated: true,
            });
        }
    }
    Ok(KvCountResult {
        total: seen.len(),
        sample,
        cancelled: false,
        truncated: false,
    })
}

/// 一致するキーを消す。
///
/// SCANの途中で消していくので、キーが増減していると
/// 1回では取りきれないことがある (もう一度実行すれば残りが消える)
pub async fn delete_keys(
    conn: &mut MultiplexedConnection,
    pattern: &str,
    job: Option<&CsvJob>,
) -> Result<KvDeleteResult, String> {
    let pattern = pattern.trim();
    let mut cursor = "0".to_string();
    let mut deleted = 0usize;
    let mut seen = 0usize;
    let mut pages = 0usize;
    let mut batch: Vec<Vec<u8>> = Vec::with_capacity(DELETE_BATCH);

    loop {
        if job.is_some_and(|j| j.is_cancelled()) {
            // 溜まっているぶんは消さずに終わる (止めた時点で打ち切る)
            return Ok(KvDeleteResult {
                deleted,
                cancelled: true,
                truncated: false,
            });
        }
        let (next, keys) = match scan_page(conn, pattern, &cursor).await {
            Ok(v) => v,
            Err(e) => return Err(partly_deleted(deleted, &e)),
        };
        pages += 1;
        seen += keys.len();
        batch.extend(keys);
        cursor = next;

        while batch.len() >= DELETE_BATCH {
            let chunk: Vec<Vec<u8>> = batch.drain(0..DELETE_BATCH).collect();
            match unlink(conn, &chunk).await {
                Ok(n) => deleted += n,
                Err(e) => return Err(partly_deleted(deleted, &e)),
            }
            if let Some(j) = job {
                j.set_rows(deleted);
            }
        }
        if cursor == "0" {
            break;
        }
        if seen >= MAX_SCANNED || pages >= MAX_PAGES {
            // 打ち切りの最後の書き出しでも、止めたぶんは消さない
            if job.is_some_and(|j| j.is_cancelled()) {
                return Ok(KvDeleteResult {
                    deleted,
                    cancelled: true,
                    truncated: false,
                });
            }
            if !batch.is_empty() {
                match unlink(conn, &batch).await {
                    Ok(n) => deleted += n,
                    Err(e) => return Err(partly_deleted(deleted, &e)),
                }
                if let Some(j) = job {
                    j.set_rows(deleted);
                }
            }
            return Ok(KvDeleteResult {
                deleted,
                cancelled: false,
                truncated: true,
            });
        }
    }
    /*
     * 最後の書き出し。
     * ループを抜けてからここまでの間に切断されることがあり、
     * そのまま流すと止めた後に最大 DELETE_BATCH - 1 件を消してしまう。
     * 消すのは取り消せないので、直前にもう一度見る
     */
    if job.is_some_and(|j| j.is_cancelled()) {
        return Ok(KvDeleteResult {
            deleted,
            cancelled: true,
            truncated: false,
        });
    }
    if !batch.is_empty() {
        match unlink(conn, &batch).await {
            Ok(n) => deleted += n,
            Err(e) => return Err(partly_deleted(deleted, &e)),
        }
        if let Some(j) = job {
            j.set_rows(deleted);
        }
    }
    Ok(KvDeleteResult {
        deleted,
        cancelled: false,
        truncated: false,
    })
}

/// 途中で失敗したときのメッセージ。
/// 取り消せない操作なので、そこまでに消えた件数は必ず伝える
fn partly_deleted(deleted: usize, err: &str) -> String {
    format!("{err}\n({deleted}件を削除したところで止まりました)")
}

/// まとめて消す (UNLINKは裏で解放するのでDELより待たされない)
async fn unlink(
    conn: &mut MultiplexedConnection,
    keys: &[Vec<u8>],
) -> Result<usize, String> {
    if keys.is_empty() {
        return Ok(0);
    }
    let mut cmd = redis::cmd("UNLINK");
    for k in keys {
        cmd.arg(k.as_slice());
    }
    let n: i64 = cmd.query_async(conn).await.map_err(format_err)?;
    Ok(n.max(0) as usize)
}

/// 探し方 (大文字小文字を区別しないときは、あらかじめ小文字にしておく)
struct Matcher {
    needle: String,
    ignore_case: bool,
}

impl Matcher {
    fn new(opts: &KvSearchOptions) -> Self {
        Self {
            needle: if opts.ignore_case {
                opts.needle.to_lowercase()
            } else {
                opts.needle.clone()
            },
            ignore_case: opts.ignore_case,
        }
    }

    fn hit(&self, text: &str) -> bool {
        if self.ignore_case {
            text.to_lowercase().contains(&self.needle)
        } else {
            text.contains(&self.needle)
        }
    }
}

/// 表示用に先頭だけ切り出す (文字の途中で切らない)
fn preview(text: &str) -> String {
    match text.char_indices().nth(PREVIEW_CHARS) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

/// 値の中から探す。1件でも当たったらそのキーを返す
pub async fn search_values(
    conn: &mut MultiplexedConnection,
    pattern: &str,
    opts: &KvSearchOptions,
    job: Option<&CsvJob>,
) -> Result<KvSearchResult, String> {
    if opts.needle.is_empty() {
        return Err("探す文字列を入力してください".into());
    }
    let pattern = if pattern.trim().is_empty() {
        "*"
    } else {
        pattern.trim()
    };
    let matcher = Matcher::new(opts);
    let mut cursor = "0".to_string();
    let mut hits: Vec<KvSearchHit> = Vec::new();
    let mut scanned = 0usize;
    let mut pages = 0usize;

    loop {
        if job.is_some_and(|j| j.is_cancelled()) {
            return Ok(KvSearchResult {
                hits,
                scanned,
                cancelled: true,
                truncated: false,
            });
        }
        let (next, keys) = scan_page(conn, pattern, &cursor).await?;
        pages += 1;
        cursor = next;

        // 型はまとめて引く (キーごとの往復を減らす)
        let types = fetch_types(conn, &keys).await?;
        for (k, kv_type) in keys.iter().zip(types) {
            // キー1つずつ往復するので、ここでも中止を見る
            if job.is_some_and(|j| j.is_cancelled()) {
                return Ok(KvSearchResult {
                    hits,
                    scanned,
                    cancelled: true,
                    truncated: false,
                });
            }
            scanned += 1;
            if let Some(j) = job {
                j.set_rows(scanned);
            }
            let key = String::from_utf8_lossy(k).to_string();
            if opts.include_keys && matcher.hit(&key) {
                hits.push(KvSearchHit {
                    key,
                    kv_type,
                    field: "キー名".to_string(),
                    preview: String::new(),
                });
            } else if let Some(hit) =
                match_in_value(conn, k, &key, &kv_type, &matcher, job).await?
            {
                hits.push(hit);
            }
            if hits.len() >= SEARCH_LIMIT {
                return Ok(KvSearchResult {
                    hits,
                    scanned,
                    cancelled: false,
                    truncated: true,
                });
            }
        }
        if cursor == "0" {
            break;
        }
        if scanned >= MAX_SCANNED || pages >= MAX_PAGES {
            return Ok(KvSearchResult {
                hits,
                scanned,
                cancelled: false,
                truncated: true,
            });
        }
    }
    Ok(KvSearchResult {
        hits,
        scanned,
        cancelled: false,
        truncated: false,
    })
}

/// キーの型をまとめて引く
async fn fetch_types(
    conn: &mut MultiplexedConnection,
    keys: &[Vec<u8>],
) -> Result<Vec<String>, String> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut pipe = redis::pipe();
    for k in keys {
        pipe.cmd("TYPE").arg(k.as_slice());
    }
    let vals: Vec<String> = pipe.query_async(conn).await.map_err(format_err)?;
    Ok(vals)
}

/// HSCAN / SSCAN をカーソルが一周するまで回して要素を集める。
///
/// COUNTは目安でしかないので、1回呼んだだけでは全部返らない。
/// 上限 (`ELEMENT_LIMIT`) に達したらそこで打ち切る
async fn scan_elements(
    conn: &mut MultiplexedConnection,
    command: &str,
    raw_key: &[u8],
    job: Option<&CsvJob>,
) -> Result<Vec<Vec<u8>>, String> {
    let mut cursor = "0".to_string();
    let mut out: Vec<Vec<u8>> = Vec::new();
    let mut pages = 0usize;
    loop {
        // 要素の多いキーは1つで何度も往復するので、その途中でも止められるようにする
        if job.is_some_and(|j| j.is_cancelled()) {
            break;
        }
        let (next, items): (String, Vec<Vec<u8>>) = redis::cmd(command)
            .arg(raw_key)
            .arg(&cursor)
            .arg("COUNT")
            .arg(SCAN_COUNT)
            .query_async(conn)
            .await
            .map_err(format_err)?;
        out.extend(items);
        cursor = next;
        pages += 1;
        // カーソルが戻らないサーバーに当たっても回り続けない
        if cursor == "0" || out.len() >= ELEMENT_LIMIT || pages >= ELEMENT_PAGES {
            break;
        }
    }
    Ok(out)
}

/// 1つのキーの中身を見て、当たった場所を返す
async fn match_in_value(
    conn: &mut MultiplexedConnection,
    raw_key: &[u8],
    key: &str,
    kv_type: &str,
    matcher: &Matcher,
    job: Option<&CsvJob>,
) -> Result<Option<KvSearchHit>, String> {
    /*
     * 型ごとのコマンドが使えないサーバーもある。
     * 1つのキーで失敗しても検索全体を止めない
     */
    let found: Option<(String, String)> = match kv_type {
        "string" => {
            let raw: Vec<u8> = match redis::cmd("GETRANGE")
                .arg(raw_key)
                .arg(0)
                .arg(STRING_BYTES as i64 - 1)
                .query_async::<Vec<u8>>(conn)
                .await
            {
                Ok(v) => v,
                Err(_) => return Ok(None),
            };
            let text = bytes_to_text(&raw);
            matcher.hit(&text).then(|| (String::new(), text))
        }
        "hash" => {
            let flat = scan_elements(conn, "HSCAN", raw_key, job).await?;
            find_pair(&flat, matcher)
        }
        "list" => {
            let items: Vec<Vec<u8>> = redis::cmd("LRANGE")
                .arg(raw_key)
                .arg(0)
                .arg(ELEMENT_LIMIT as i64 - 1)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            find_indexed(&items, matcher)
        }
        "set" => {
            let items = scan_elements(conn, "SSCAN", raw_key, job).await?;
            find_member(&items, matcher)
        }
        "zset" => {
            let items: Vec<Vec<u8>> = redis::cmd("ZRANGE")
                .arg(raw_key)
                .arg(0)
                .arg(ELEMENT_LIMIT as i64 - 1)
                .query_async(conn)
                .await
                .map_err(format_err)?;
            find_member(&items, matcher)
        }
        // stream など、ここで扱わない型は飛ばす
        _ => None,
    };
    Ok(found.map(|(field, text)| KvSearchHit {
        key: key.to_string(),
        kv_type: kv_type.to_string(),
        field,
        preview: preview(&text),
    }))
}

/// フィールドと値が交互に並んだ列から探す (hash)
fn find_pair(flat: &[Vec<u8>], matcher: &Matcher) -> Option<(String, String)> {
    for pair in flat.chunks(2) {
        let field = bytes_to_text(pair.first().map(Vec::as_slice).unwrap_or(b""));
        let value = bytes_to_text(pair.get(1).map(Vec::as_slice).unwrap_or(b""));
        if matcher.hit(&value) {
            return Some((field, value));
        }
        if matcher.hit(&field) {
            return Some((field, value));
        }
    }
    None
}

/// 並び順のある列から探す (list)
fn find_indexed(items: &[Vec<u8>], matcher: &Matcher) -> Option<(String, String)> {
    for (i, v) in items.iter().enumerate() {
        let text = bytes_to_text(v);
        if matcher.hit(&text) {
            return Some((i.to_string(), text));
        }
    }
    None
}

/// メンバーの集まりから探す (set / zset)
fn find_member(items: &[Vec<u8>], matcher: &Matcher) -> Option<(String, String)> {
    for v in items {
        let text = bytes_to_text(v);
        if matcher.hit(&text) {
            return Some((String::new(), text));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(needle: &str, ignore_case: bool) -> KvSearchOptions {
        KvSearchOptions {
            needle: needle.to_string(),
            ignore_case,
            include_keys: false,
        }
    }

    #[test]
    fn パターンの決まりを確かめる() {
        assert!(check_pattern("user:*", false).is_ok());
        assert!(check_pattern("", false).is_err());
        assert!(check_pattern("   ", false).is_err());
        // 全件に当たるパターンは、そうと分かって指定したときだけ通す
        assert!(check_pattern("*", false).is_err());
        assert!(check_pattern("*", true).is_ok());
        // ワイルドカードしか無いものはどれも実質「全件」
        assert!(check_pattern("**", false).is_err());
        assert!(check_pattern("?*", false).is_err());
        assert!(check_pattern("*?*", false).is_err());
        // 1文字でも文字が入っていれば絞り込みになる
        assert!(check_pattern("?a*", false).is_ok());
    }

    #[test]
    fn 大文字小文字の扱いを切り替える() {
        let m = Matcher::new(&opts("ABC", false));
        assert!(m.hit("xxABCxx"));
        assert!(!m.hit("xxabcxx"));
        let m = Matcher::new(&opts("ABC", true));
        assert!(m.hit("xxabcxx"));
    }

    #[test]
    fn hashはフィールドと値の両方から探す() {
        let flat = vec![b"name".to_vec(), b"taro".to_vec()];
        let m = Matcher::new(&opts("taro", false));
        assert_eq!(
            find_pair(&flat, &m),
            Some(("name".to_string(), "taro".to_string()))
        );
        let m = Matcher::new(&opts("name", false));
        assert_eq!(
            find_pair(&flat, &m),
            Some(("name".to_string(), "taro".to_string()))
        );
        let m = Matcher::new(&opts("見つからない", false));
        assert_eq!(find_pair(&flat, &m), None);
    }

    #[test]
    fn listは何番目かを返す() {
        let items = vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()];
        let m = Matcher::new(&opts("c", false));
        assert_eq!(
            find_indexed(&items, &m),
            Some(("2".to_string(), "c".to_string()))
        );
    }

    #[test]
    fn プレビューは長い値を切り詰める() {
        let long = "あ".repeat(300);
        let p = preview(&long);
        assert!(p.ends_with('…'));
        // 文字の途中で切らない (バイト数ではなく文字数で数える)
        assert_eq!(p.chars().filter(|c| *c == 'あ').count(), PREVIEW_CHARS);
        // ちょうど収まる長さなら切らない
        assert_eq!(preview("あいう"), "あいう");
    }
}
