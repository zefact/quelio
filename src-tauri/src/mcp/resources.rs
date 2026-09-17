//! スキーマ全体を1つの資料 (Resource) として渡す。
//!
//! `describe_table` を何十回も呼ばせるより、
//! 「このDBの定義はこれです」と1つ添付してもらう方が、
//! AIの読み込みも利用者の待ち時間も短い。
//!
//! 中身は既存のスキーマ収集 (`sessions::schema_snapshot`) をそのまま使い、
//! ここでは URI の読み書きと Markdown の組み立てだけを行う

use tauri::{AppHandle, Manager};

use crate::export::parse_comment;
use crate::models::{ConnectionStore, DbType, SchemaEntry};

use super::rows::md_escape;
use super::{catalog, session};

/// URI の先頭
pub const SCHEME: &str = "quelio://";

/// URI の末尾 (今はスキーマだけ)
const SCHEMA_PART: &str = "schema";

pub const MIME: &str = "text/markdown";

/// 既定以外のDBを指せるようにする雛形
pub const URI_TEMPLATE: &str = "quelio://{connection}/{database}/schema";

/// 返す大きさの目安。
///
/// 超えた分は切って「残りは describe_table で」と書き添える。
/// AIの入力を1つの資料で埋めてしまうと、肝心の会話が入らなくなる
pub const MAX_BYTES: usize = 200 * 1024;

pub const BAD_URI: &str = "Quelioが扱えるURIではありません";

/// DBを省いたURIを読もうとしたときの文言
pub const NEED_DATABASE: &str =
    "データベースを指定してください (例: quelio://<接続名>/<DB名>/schema)";

/// SQLiteを一覧に出すときのDB名。
///
/// SQLiteはファイル1つでデータベースの区別が無いが、
/// URIの形をそろえるために置く (読むときは無視する)
pub const SQLITE_DB: &str = "main";

/// URI が指している先
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub connection: String,
    /// 指定が無ければ接続の既定データベース
    pub database: Option<String>,
}

/// URI に入れられない文字を逃がす。
///
/// 区切りの `/` と、URIで意味を持つ記号だけを対象にする。
/// 日本語まで全部逃がすと、クライアントに出たとき人が読めなくなる
fn encode(part: &str) -> String {
    let mut out = String::with_capacity(part.len());
    for c in part.chars() {
        match c {
            '%' | '/' | '?' | '#' | ' ' => {
                for b in c.to_string().as_bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
            c if (c as u32) < 0x20 => out.push_str(&format!("%{:02X}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// 逃がした文字を戻す (`%XX` 以外はそのまま)
fn decode(part: &str) -> Result<String, String> {
    let bytes = part.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = part.get(i + 1..i + 3).ok_or(BAD_URI)?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| BAD_URI.to_string())?);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).map_err(|_| BAD_URI.to_string())
}

/// スキーマを指す URI。
///
/// データベースを省くと「接続の既定DB」を指す
pub fn schema_uri(connection: &str, database: Option<&str>) -> String {
    match database {
        Some(db) => format!(
            "{SCHEME}{}/{}/{SCHEMA_PART}",
            encode(connection),
            encode(db)
        ),
        None => format!("{SCHEME}{}/{SCHEMA_PART}", encode(connection)),
    }
}

/// URI を読む。
///
/// `quelio://<接続名>/schema` と `quelio://<接続名>/<DB名>/schema` の2つだけ。
/// それ以外は断る (勝手に解釈して別のものを返さない)
pub fn parse_uri(uri: &str) -> Result<Target, String> {
    let rest = uri.strip_prefix(SCHEME).ok_or(BAD_URI)?;
    let parts: Vec<&str> = rest.split('/').collect();
    match parts.as_slice() {
        [conn, tail] if !conn.is_empty() && *tail == SCHEMA_PART => Ok(Target {
            connection: decode(conn)?,
            database: None,
        }),
        [conn, db, tail] if !conn.is_empty() && !db.is_empty() && *tail == SCHEMA_PART => {
            Ok(Target {
                connection: decode(conn)?,
                database: Some(decode(db)?),
            })
        }
        _ => Err(BAD_URI.to_string()),
    }
}

/// 省略したときの書き添え
fn omitted(rest: usize) -> String {
    format!("\n… 残り {rest} テーブルは省略 (describe_table で個別に参照)\n")
}

/// テーブル1つぶんの定義を Markdown にする
fn table_markdown(entry: &SchemaEntry, delim: &str) -> String {
    let t = &entry.table;
    let name = match &t.schema {
        Some(s) if !s.is_empty() => format!("{s}.{}", t.name),
        _ => t.name.clone(),
    };
    let (label, _) = parse_comment(t.comment.as_deref().unwrap_or(""), delim);

    let mut out = String::new();
    if label.is_empty() {
        out.push_str(&format!("## {}\n", md_escape(&name)));
    } else {
        out.push_str(&format!(
            "## {} ({})\n",
            md_escape(&name),
            md_escape(&label)
        ));
    }
    if t.table_type.to_uppercase().contains("VIEW") {
        out.push_str("\nビュー\n");
    }

    out.push_str("\n| カラム | 型 | NULL | 論理名 | 備考 |\n");
    out.push_str("| --- | --- | --- | --- | --- |\n");
    let mut pk: Vec<String> = Vec::new();
    for c in &entry.detail.columns {
        let (logical, note) = parse_comment(c.comment.as_deref().unwrap_or(""), delim);
        out.push_str(&format!(
            "| {} | {} | {} | {} | {} |\n",
            md_escape(&c.name),
            md_escape(&c.col_type),
            if c.nullable { "YES" } else { "NO" },
            md_escape(&logical),
            md_escape(&note),
        ));
        if c.key.as_deref() == Some("PRI") {
            pk.push(c.name.clone());
        }
    }
    if !pk.is_empty() {
        out.push_str(&format!("\nPK: {}\n", pk.join(", ")));
    }
    for f in &entry.detail.foreign_keys {
        let to = if f.ref_schema.is_empty() {
            f.ref_table.clone()
        } else {
            format!("{}.{}", f.ref_schema, f.ref_table)
        };
        out.push_str(&format!(
            "FK: {} → {}({})\n",
            f.columns.join(", "),
            to,
            f.ref_columns.join(", ")
        ));
    }
    out
}

/// スキーマ全体を Markdown にする。
///
/// テーブルは名前順に出し、`max_bytes` を超えたところで打ち切る。
/// 「どこまで入ったか」が分かるように、省略した数を最後に書く
pub fn to_markdown(
    connection: &str,
    database: &str,
    entries: &[SchemaEntry],
    delim: &str,
    max_bytes: usize,
) -> String {
    let mut sorted: Vec<&SchemaEntry> = entries.iter().collect();
    sorted.sort_by(|a, b| {
        let key = |e: &SchemaEntry| {
            (
                e.table.schema.clone().unwrap_or_default(),
                e.table.name.clone(),
            )
        };
        key(a).cmp(&key(b))
    });

    let head = if database.is_empty() {
        format!("# {connection} のスキーマ\n\n")
    } else {
        format!("# {connection} / {database} のスキーマ\n\n")
    };
    let mut out = head;
    out.push_str(&format!("テーブル {} 件\n", sorted.len()));

    for (i, e) in sorted.iter().enumerate() {
        let body = format!("\n{}", table_markdown(e, delim));
        let rest = sorted.len() - i;
        // 打ち切りの書き添えぶんも収まるかを見る (書き添えで溢れては意味が無い)
        if out.len() + body.len() + omitted(rest).len() > max_bytes {
            out.push_str(&omitted(rest));
            return out;
        }
        out.push_str(&body);
    }
    out
}

/// URIの形が悪いだけの失敗か (AIが直せる問題か)
pub fn is_bad_uri(message: &str) -> bool {
    message == BAD_URI || message == NEED_DATABASE
}

/// 一覧に出す1件
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub connection: String,
    /// 指す先のデータベース名
    pub database: String,
}

/**
 * 一覧に出せる接続を選ぶ。
 *
 * 既定データベースが決まっていない接続は出さない。
 * 出しておいて読めない資料になるより、
 * 雛形 (`URI_TEMPLATE`) でDBを指してもらう方がよい
 */
fn listed(store: &ConnectionStore) -> Vec<Listed> {
    store
        .connections
        .iter()
        // 公開の範囲は `ai_connections` と同じ判断にそろえる
        .filter(|c| c.ai_access.is_exposed() && c.db_type != DbType::Valkey)
        .filter_map(|c| {
            let database = match c.db_type {
                DbType::Sqlite => SQLITE_DB.to_string(),
                _ => c.database.clone().unwrap_or_default().trim().to_string(),
            };
            (!database.is_empty()).then(|| Listed {
                connection: c.name.clone(),
                database,
            })
        })
        .collect()
}

/// AIへ見せるスキーマ資料の一覧 (公開中の接続 × 既定DB)
pub fn list(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
    // 復号しない読み込みで足りる (名前と公開レベルだけ見る)
    let store = crate::storage::load_without_secrets(app)?;
    Ok(listed(&store)
        .into_iter()
        .map(|l| (schema_uri(&l.connection, Some(&l.database)), l.connection))
        .collect())
}

/// URI の中身を作る
pub async fn read(app: &AppHandle, uri: &str) -> Result<String, String> {
    let target = parse_uri(uri)?;
    /*
     * DBを省いた形は受けない。
     * 既定DBが無い接続では空のDBを見に行くことになり、
     * 「読めたのに何も入っていない資料」が返ってしまう
     */
    let Some(db) = target.database.clone() else {
        return Err(NEED_DATABASE.to_string());
    };
    let db = Some(db);
    session::with_session(app, &target.connection, move |o| {
        let db = db.clone();
        async move {
            let database = catalog::database_of(&o, db);
            let sessions = app.state::<crate::sessions::Sessions>();
            let qlog = app.state::<crate::query_log::QueryLog>();
            let entries = crate::sessions::schema_snapshot(
                &sessions,
                &qlog,
                &o.session_id,
                &database,
            )
            .await?;
            let delim = crate::app_settings::load(app)
                .map(|s| s.comment_delimiter)
                .unwrap_or_else(|_| "（".to_string());
            Ok(to_markdown(
                &o.name,
                &database,
                &entries,
                &delim,
                MAX_BYTES,
            ))
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ColumnInfo, TableDetail, TableInfo};

    #[test]
    fn 既定dbのuriを往復できる() {
        let uri = schema_uri("開発DB", None);
        assert_eq!(uri, "quelio://開発DB/schema");
        assert_eq!(
            parse_uri(&uri).expect("読めること"),
            Target {
                connection: "開発DB".to_string(),
                database: None
            }
        );
    }

    #[test]
    fn db指定のuriを往復できる() {
        let uri = schema_uri("開発DB", Some("shop"));
        assert_eq!(uri, "quelio://開発DB/shop/schema");
        assert_eq!(
            parse_uri(&uri).expect("読めること"),
            Target {
                connection: "開発DB".to_string(),
                database: Some("shop".to_string())
            }
        );
    }

    #[test]
    fn 区切りや空白の混じった名前も往復できる() {
        for name in ["a/b", "a b", "100%", "a?b", "a#b"] {
            let uri = schema_uri(name, None);
            assert!(!uri[SCHEME.len()..].contains(' '), "{uri}");
            assert_eq!(
                parse_uri(&uri).expect("読めること").connection,
                name,
                "{uri}"
            );
        }
    }

    #[test]
    fn 形の違うuriは断る() {
        for uri in [
            "http://開発DB/schema",
            "quelio://開発DB",
            "quelio:///schema",
            "quelio://開発DB/shop/tables",
            "quelio://開発DB/shop/extra/schema",
            "quelio://開発DB//schema",
        ] {
            assert_eq!(parse_uri(uri).expect_err("断ること"), BAD_URI, "{uri}");
        }
    }

    fn store(items: &[(&str, DbType, Option<&str>, crate::models::AiAccess)]) -> ConnectionStore {
        let connections = items
            .iter()
            .map(|(name, db_type, database, access)| crate::models::ConnectionProfile {
                id: format!("id-{name}"),
                name: (*name).to_string(),
                db_type: *db_type,
                host: String::new(),
                port: 0,
                user: String::new(),
                password: String::new(),
                database: database.map(|d| d.to_string()),
                tls: false,
                ssl_mode: None,
                ca_cert_path: None,
                client_cert_path: None,
                client_key_path: None,
                read_only: false,
                ssh: None,
                proxy: None,
                folder_id: None,
                color: None,
                env: None,
                ai_access: *access,
                pinned: false,
                last_used_at: None,
                password_locked: false,
                password_saved: false,
                passphrase_saved: false,
            })
            .collect();
        ConnectionStore {
            folders: Vec::new(),
            connections,
            root_order: Vec::new(),
        }
    }

    #[test]
    fn 既定dbのある接続だけを一覧に出す() {
        use crate::models::AiAccess;
        let s = store(&[
            ("既定あり", DbType::Mysql, Some("shop"), AiAccess::Read),
            ("既定なし", DbType::Mysql, None, AiAccess::Read),
            ("空欄", DbType::Postgresql, Some("  "), AiAccess::Read),
            ("公開なし", DbType::Mysql, Some("shop"), AiAccess::None),
            ("ファイル", DbType::Sqlite, Some("/tmp/a.db"), AiAccess::Read),
        ]);
        let got = listed(&s);
        assert_eq!(
            got,
            vec![
                Listed {
                    connection: "既定あり".to_string(),
                    database: "shop".to_string()
                },
                // SQLiteはファイル1つなので固定の名前で出す
                Listed {
                    connection: "ファイル".to_string(),
                    database: SQLITE_DB.to_string()
                },
            ]
        );
    }

    #[test]
    fn 一覧のuriはdbまで含む() {
        use crate::models::AiAccess;
        let s = store(&[("開発DB", DbType::Mysql, Some("shop"), AiAccess::Read)]);
        let l = &listed(&s)[0];
        let uri = schema_uri(&l.connection, Some(&l.database));
        assert_eq!(uri, "quelio://開発DB/shop/schema");
        assert_eq!(
            parse_uri(&uri).expect("読めること").database.as_deref(),
            Some("shop")
        );
    }

    #[test]
    fn 壊れた逃がし方は断る() {
        assert_eq!(parse_uri("quelio://a%2/schema").expect_err("断ること"), BAD_URI);
        assert_eq!(parse_uri("quelio://a%ZZ/schema").expect_err("断ること"), BAD_URI);
    }

    fn column(name: &str, col_type: &str, comment: Option<&str>, pk: bool) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            col_type: col_type.to_string(),
            nullable: !pk,
            key: pk.then(|| "PRI".to_string()),
            default: None,
            extra: None,
            collation: None,
            comment: comment.map(|c| c.to_string()),
        }
    }

    fn entry(name: &str, comment: Option<&str>) -> SchemaEntry {
        SchemaEntry {
            table: TableInfo {
                schema: None,
                name: name.to_string(),
                table_type: "BASE TABLE".to_string(),
                row_estimate: Some(10),
                comment: comment.map(|c| c.to_string()),
                partition_by: None,
                partition_of: None,
            },
            detail: TableDetail {
                columns: vec![
                    column("id", "int", Some("ID"), true),
                    column("name", "varchar(100)", Some("氏名（本名）"), false),
                ],
                indexes: Vec::new(),
                foreign_keys: Vec::new(),
                info: Vec::new(),
            },
        }
    }

    #[test]
    fn 論理名つきの定義を出す() {
        let got = to_markdown(
            "開発DB",
            "shop",
            &[entry("users", Some("利用者"))],
            "（",
            MAX_BYTES,
        );
        assert!(got.starts_with("# 開発DB / shop のスキーマ"), "{got}");
        assert!(got.contains("テーブル 1 件"), "{got}");
        assert!(got.contains("## users (利用者)"), "{got}");
        assert!(got.contains("| id | int | NO | ID |  |"), "{got}");
        // 論理名と備考は区切りで分ける
        assert!(got.contains("| name | varchar(100) | YES | 氏名 | 本名 |"), "{got}");
        assert!(got.contains("\nPK: id\n"), "{got}");
    }

    #[test]
    fn テーブルは名前順に出す() {
        let got = to_markdown(
            "c",
            "",
            &[entry("zebra", None), entry("apple", None)],
            "（",
            MAX_BYTES,
        );
        let a = got.find("## apple").expect("あること");
        let z = got.find("## zebra").expect("あること");
        assert!(a < z, "{got}");
        // DB名が無ければ見出しに入れない
        assert!(got.starts_with("# c のスキーマ"), "{got}");
    }

    #[test]
    fn 上限を超えたら省略の注記を付ける() {
        let entries: Vec<SchemaEntry> = (0..10)
            .map(|i| entry(&format!("t{i:02}"), None))
            .collect();
        let got = to_markdown("c", "d", &entries, "（", 400);
        assert!(got.contains("は省略 (describe_table で個別に参照)"), "{got}");
        // 書き添えを入れても上限に収まる
        assert!(got.len() <= 400, "{}", got.len());
        // 先頭のテーブルは入っている
        assert!(got.contains("## t00"), "{got}");
    }
}
