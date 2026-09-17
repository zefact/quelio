//! AIへ渡す「接続の姿」。
//!
//! ここが AI連携 の肝になる。
//! `ConnectionProfile` をそのまま serialize すれば、
//! パスワード・SSH鍵・ホスト名まで一緒に出ていってしまう。
//!
//! そこで **秘密情報を持てない別の型** を用意し、AIへはこれしか渡さない。
//! 「うっかりフィールドを足す」ことができないよう、型の側で閉じてある
//! (`storage::mask_secrets` と同じ考え方)

use serde::Serialize;

use crate::models::{ConnectionStore, DbType};

/// AIへ見せる接続1件。
///
/// ホスト・ポート・利用者名・パスワード・SSHの設定は **1つも持たない**。
/// AIが知るのは「接続名」だけで、そこから先はQuelioが持っている設定で繋ぐ
#[derive(Debug, Clone, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiConnection {
    /// 接続名。以降のツールは、この名前で接続を指す
    pub name: String,
    /// DBの種別 ("mysql" / "postgresql" / "sqlite")
    pub db_type: String,
    /// 環境ラベル ("prod" / "staging" / "dev"。未設定なら null)
    pub env: Option<String>,
    /// 公開レベル ("read" = 参照のみ / "write" = 更新はQuelioでの許可が要る)
    pub access: String,
}

/// `list_connections` が返すもの
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiConnections {
    pub connections: Vec<AiConnection>,
}

/// AIへ公開する接続だけを取り出す。
///
/// 外すのは2種類:
/// - 公開レベルが「公開しない」(既定) の接続
/// - Valkey (第1弾はSQLを書くDBだけを対象にする)
pub fn ai_connections(store: &ConnectionStore) -> Vec<AiConnection> {
    store
        .connections
        .iter()
        .filter(|c| c.ai_access.is_exposed() && c.db_type != DbType::Valkey)
        .map(|c| AiConnection {
            name: c.name.clone(),
            db_type: match c.db_type {
                DbType::Mysql => "mysql",
                DbType::Postgresql => "postgresql",
                DbType::Sqlite => "sqlite",
                DbType::Valkey => "valkey",
            }
            .to_string(),
            env: c.env.clone(),
            access: c.ai_access.as_str().to_string(),
        })
        .collect()
}

/// AIへ見せるデータベース (PostgreSQLはスキーマも)
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiDatabases {
    /// データベース名の一覧 (SQLiteはファイル1つなので空)
    pub databases: Vec<String>,
}

/// AIへ見せるテーブル1件
#[derive(Debug, Clone, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiTable {
    /// スキーマ名 (PostgreSQLのみ。他は null)
    pub schema: Option<String>,
    pub name: String,
    /// 日本語名 (テーブルコメントの論理名。無ければ null)
    pub label: Option<String>,
    /// "table" / "view"
    pub kind: String,
    /// 概算の行数 (取れなければ null)
    pub row_estimate: Option<i64>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiTables {
    pub tables: Vec<AiTable>,
}

/// AIへ見せるカラム1件
#[derive(Debug, Clone, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiColumn {
    pub name: String,
    /// 型 (例: varchar(100))
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    /// 日本語名 (コメントの論理名)
    pub label: Option<String>,
    /// 補足 (コメントの区切りより後ろ)
    pub note: Option<String>,
    /// 主キーの一部か
    pub primary_key: bool,
}

/// AIへ見せるインデックス1件
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiIndex {
    pub name: String,
    pub unique: bool,
    /// 対象カラム (PostgreSQLは定義式)
    pub columns: String,
}

/// AIへ見せる外部キー1件
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

/// `describe_table` が返すもの
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiTableDetail {
    pub table: String,
    /// テーブルの日本語名 (コメントの論理名)
    pub label: Option<String>,
    pub columns: Vec<AiColumn>,
    pub indexes: Vec<AiIndex>,
    pub foreign_keys: Vec<AiForeignKey>,
}

/// 列の値1つとその件数
#[derive(Debug, Clone, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiColumnValue {
    pub value: String,
    pub count: i64,
}

/// `column_values` が返すもの
#[derive(Debug, Clone, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiColumnValues {
    pub column: String,
    /// 件数の多い順。NULL はここに入れない
    pub values: Vec<AiColumnValue>,
    /// NULL の件数。
    ///
    /// 上限で打ち切って、なおかつ NULL が上位に出てこなかったときは null
    /// (0件と言い切れないため)
    pub null_count: Option<i64>,
    /// 上限に達して打ち切ったか (ほかにも値がある)
    pub truncated: bool,
    /// 確かめられた種類の数 (打ち切った場合はこれ以上ある)
    pub distinct_at_least: usize,
}

/// `open_in_editor` が返すもの
#[derive(Debug, Clone, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiOpenedSheet {
    /// 置いたシートの名前 (利用者に伝えるため)
    pub sheet: String,
    /// 置けたか (実行はしていない)
    pub opened: bool,
}

/// `search_schema` の当たり1件
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiHit {
    pub database: String,
    pub schema: String,
    pub table: String,
    /// カラム名 (テーブル名が一致したときは空)
    pub column: String,
    pub data_type: String,
    /// コメント (論理名と補足をそのまま)
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiSearchResult {
    pub hits: Vec<AiHit>,
    /// 上限に達して打ち切ったか
    pub truncated: bool,
}

/// 結果の列 (名前と型)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiResultColumn {
    pub name: String,
    /// ドライバが返す型名 (DBごとの呼び方のまま)。
    ///
    /// 取れない経路では null。空文字で返すと
    /// 「型名が空のもの」と読まれかねないので、無いことを無いと示す
    #[serde(rename = "type")]
    pub data_type: Option<String>,
}

/// `run_query` / `explain` が返すもの
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AiRows {
    pub columns: Vec<AiResultColumn>,
    /// セル値 (NULLは null)。`format` が json のときだけ入る
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<Vec<Option<String>>>>,
    /// Markdown / CSV にしたときの本文 (json のときは null)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 返した行数
    pub row_count: usize,
    /// 上限で打ち切ったか (続きがある)
    pub truncated: bool,
    /// 更新系で、影響した行数 (参照系は null)
    pub rows_affected: Option<u64>,
    pub elapsed_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AiAccess, ConnectionProfile, SshConfig};

    fn profile(name: &str, access: AiAccess, db_type: DbType) -> ConnectionProfile {
        ConnectionProfile {
            id: format!("id-{name}"),
            name: name.to_string(),
            db_type,
            host: "db.internal.example.com".to_string(),
            port: 3306,
            user: "admin".to_string(),
            password: "とても秘密のパスワード".to_string(),
            database: Some("app".to_string()),
            tls: false,
            ssl_mode: None,
            ca_cert_path: None,
            client_cert_path: None,
            client_key_path: None,
            read_only: false,
            ssh: Some(SshConfig {
                enabled: true,
                host: "bastion.example.com".to_string(),
                port: 22,
                user: "ops".to_string(),
                key_path: "/home/me/.ssh/id_ed25519".to_string(),
                passphrase: Some("鍵のパスフレーズ".to_string()),
            }),
            proxy: None,
            folder_id: None,
            color: None,
            env: Some("dev".to_string()),
            ai_access: access,
            pinned: false,
            last_used_at: None,
            password_locked: false,
            password_saved: false,
            passphrase_saved: false,
        }
    }

    fn store(profiles: Vec<ConnectionProfile>) -> ConnectionStore {
        ConnectionStore {
            connections: profiles,
            ..Default::default()
        }
    }

    #[test]
    fn 公開しない接続は一覧に出ない() {
        let s = store(vec![
            profile("秘密", AiAccess::None, DbType::Mysql),
            profile("見せる", AiAccess::Read, DbType::Mysql),
        ]);
        let got = ai_connections(&s);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "見せる");
        assert_eq!(got[0].access, "read");
    }

    #[test]
    fn valkeyは公開していても出さない() {
        // 第1弾はSQLを書くDBだけを対象にする
        let s = store(vec![profile("kv", AiAccess::Write, DbType::Valkey)]);
        assert!(ai_connections(&s).is_empty());
    }

    #[test]
    fn 秘密情報は値としてもキー名としても出ない() {
        let s = store(vec![profile("見せる", AiAccess::Write, DbType::Postgresql)]);
        let json = serde_json::to_string(&ai_connections(&s)).expect("書けること");
        // 値
        for secret in [
            "とても秘密のパスワード",
            "鍵のパスフレーズ",
            "db.internal.example.com",
            "bastion.example.com",
            "id_ed25519",
            "admin",
        ] {
            assert!(!json.contains(secret), "{secret} が出ている: {json}");
        }
        // キー名 (将来フィールドを足したときにも気づけるように、名前でも見る)
        for key in ["password", "passphrase", "host", "ssh", "user", "port", "key"] {
            assert!(!json.contains(key), "{key} というキーがある: {json}");
        }
    }

    #[test]
    fn ai向けの型に秘密情報のキーが無い() {
        /*
         * 一覧だけでなく、あとから足した型にも同じ歯止めを掛ける。
         * フィールドを増やしたときに、うっかり接続情報を持たせてしまうのを
         * ここで落とす
         */
        let json = [
            serde_json::to_string(&AiDatabases {
                databases: vec!["appdb".into()],
            }),
            serde_json::to_string(&AiTables {
                tables: vec![AiTable {
                    schema: Some("public".into()),
                    name: "orders".into(),
                    label: Some("受注".into()),
                    kind: "table".into(),
                    row_estimate: Some(10),
                }],
            }),
            serde_json::to_string(&AiTableDetail {
                table: "orders".into(),
                label: Some("受注".into()),
                columns: vec![AiColumn {
                    name: "id".into(),
                    data_type: "bigint".into(),
                    nullable: false,
                    default: None,
                    label: Some("受注ID".into()),
                    note: None,
                    primary_key: true,
                }],
                indexes: vec![AiIndex {
                    name: "PRIMARY".into(),
                    unique: true,
                    columns: "id".into(),
                }],
                foreign_keys: vec![AiForeignKey {
                    name: "fk".into(),
                    columns: vec!["customer_id".into()],
                    ref_table: "customers".into(),
                    ref_columns: vec!["id".into()],
                }],
            }),
            serde_json::to_string(&AiSearchResult {
                hits: vec![AiHit {
                    database: "appdb".into(),
                    schema: String::new(),
                    table: "orders".into(),
                    column: "amount".into(),
                    data_type: "int".into(),
                    comment: "金額".into(),
                }],
                truncated: false,
            }),
            serde_json::to_string(&AiRows {
                columns: vec![AiResultColumn {
                    name: "n".into(),
                    data_type: Some("INTEGER".into()),
                }],
                rows: Some(vec![vec![Some("1".into())]]),
                text: None,
                row_count: 1,
                truncated: false,
                rows_affected: None,
                elapsed_ms: 2,
            }),
        ]
        .map(|r| r.expect("書けること"))
        .join("");

        for key in ["password", "passphrase", "\"host\"", "ssh", "\"user\"", "\"port\""] {
            assert!(!json.contains(key), "{key} というキーがある: {json}");
        }
    }

    #[test]
    fn 名前と種別と環境と公開レベルだけを返す() {
        let s = store(vec![profile("本番参照", AiAccess::Read, DbType::Sqlite)]);
        let got = &ai_connections(&s)[0];
        assert_eq!(got.name, "本番参照");
        assert_eq!(got.db_type, "sqlite");
        assert_eq!(got.env.as_deref(), Some("dev"));
        assert_eq!(got.access, "read");
    }
}