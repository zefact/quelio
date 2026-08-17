use serde::{Deserialize, Serialize};

/// 対象DBの種別
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbType {
    Mysql,
    Postgresql,
    /// SQLite (ファイルベース。databaseフィールドにファイルパスを入れる)
    Sqlite,
    Valkey,
}

/// SSH踏み台(トンネル)設定
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub enabled: bool,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub user: String,
    /// 秘密鍵ファイルのパス (例: ~/.ssh/id_ed25519)
    pub key_path: String,
    /// 鍵のパスフレーズ(任意)
    #[serde(default)]
    pub passphrase: Option<String>,
}

fn default_ssh_port() -> u16 {
    22
}

/// 保存する接続プロファイル
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    /// UUID。新規作成時は空文字で送られ、保存時に採番する
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub db_type: DbType,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub password: String,
    /// 接続先データベース名(任意)
    #[serde(default)]
    pub database: Option<String>,
    /// TLSで接続する (Valkey用。AWS ElastiCache等のin-transit暗号化)
    #[serde(default)]
    pub tls: bool,
    /// SSHトンネル設定(任意)
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    /// 所属フォルダのID (Noneならルート直下)
    #[serde(default)]
    pub folder_id: Option<String>,
    /// アイコン色 (#rrggbb。NoneならDB種別ごとの既定色)
    #[serde(default)]
    pub color: Option<String>,
}

/// 接続先を整理するフォルダ
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub id: String,
    pub name: String,
    /// 折りたたみ状態
    #[serde(default)]
    pub collapsed: bool,
    /// アイコン色 (#rrggbb。Noneなら既定のアンバー)
    #[serde(default)]
    pub color: Option<String>,
}

/// 保存される接続先一式 (フォルダ + 接続。配列順 = 表示順)
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStore {
    #[serde(default)]
    pub folders: Vec<FolderInfo>,
    #[serde(default)]
    pub connections: Vec<ConnectionProfile>,
    /// ルート階層の表示順 (フォルダIDとフォルダ未所属の接続IDが混在)。
    /// 空の場合は従来どおり「フォルダ → 接続」の順で表示する
    #[serde(default)]
    pub root_order: Vec<String>,
}

/// 並べ替え・フォルダ移動の保存用エントリ
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutEntry {
    pub id: String,
    #[serde(default)]
    pub folder_id: Option<String>,
}

/// 接続確立時に返す情報
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    /// サーバー上のデータベース一覧
    pub databases: Vec<String>,
    /// 現在接続中のデータベース(あれば)
    pub current_db: Option<String>,
    /// サーバー情報 (バージョン・文字コード・照合順序など。ラベルと値の組)
    #[serde(default)]
    pub server_info: Vec<(String, String)>,
}

/// テーブル一覧の1件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    /// スキーマ名 (PostgreSQLのみ。MySQLはNone)
    pub schema: Option<String>,
    pub name: String,
    /// BASE TABLE / VIEW など
    pub table_type: String,
    /// 概算行数 (取得できない場合はNone)
    pub row_estimate: Option<i64>,
}

/// カラム定義の1件
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    /// 型 (例: varchar(100), int unsigned)
    pub col_type: String,
    pub nullable: bool,
    /// PRI / UNI / MUL など
    pub key: Option<String>,
    pub default: Option<String>,
    /// auto_increment / on update CURRENT_TIMESTAMP など
    pub extra: Option<String>,
    pub collation: Option<String>,
    pub comment: Option<String>,
}

/// インデックスの1件
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub unique: bool,
    /// 対象カラム (PostgreSQLは定義式)
    pub columns: String,
    pub index_type: Option<String>,
    pub cardinality: Option<i64>,
}

/// 外部キーの1件 (ER図のリレーション用)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FkInfo {
    pub table: String,
    pub column: String,
    pub ref_table: String,
    pub ref_column: String,
}

/// テーブル構造の詳細
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDetail {
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    /// テーブル情報 (ラベル, 値) の組
    pub info: Vec<(String, String)>,
}

/// SQL実行の結果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    /// セル値 (Noneは NULL)
    pub rows: Vec<Vec<Option<String>>>,
    /// このページの先頭行のオフセット
    pub offset: usize,
    /// 次のページが存在するか
    pub has_more: bool,
    /// ページング可能なクエリだったか (LIMIT自動付与できたか)
    pub pageable: bool,
    /// サーバーサイドソート中のカラム名
    pub order_by: Option<String>,
    /// サーバーサイドソートの方向 (asc / desc)
    pub order_dir: Option<String>,
    /// 更新系クエリの影響行数
    pub rows_affected: Option<u64>,
    pub elapsed_ms: u64,
}

/// スキーマスナップショットの1テーブル分
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaEntry {
    pub table: TableInfo,
    pub detail: TableDetail,
}

/// 開いているセッションの概要 (差分ビューアの選択肢用)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    /// 接続プロファイルのID (ER図の保存キーなど、再起動をまたぐ紐付けに使う)
    pub profile_id: String,
    pub name: String,
    pub db_type: DbType,
    pub databases: Vec<String>,
    pub current_db: Option<String>,
}

/// 1文ぶんの実行結果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    /// 実行した文 (タブ表示用)
    pub sql: String,
    pub result: QueryResult,
}

/// 複数文実行の全体結果。エラー時も途中までの結果を返す
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutput {
    pub statements: Vec<StatementResult>,
    /// 途中でエラーになった場合のメッセージ
    pub error: Option<String>,
    /// エラーになった文のインデックス (0始まり)
    pub failed_index: Option<usize>,
}

/// SQL実行結果のCSV出力結果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvExportResult {
    /// 保存したファイルのフルパス (キャンセル時は空)
    pub path: String,
    /// 書き出した行数 (ヘッダ行は含まない)
    pub rows: usize,
    /// 途中でキャンセルされたか (この場合ファイルは残さない)
    pub cancelled: bool,
}

/// 接続テストの結果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub success: bool,
    pub message: String,
    pub server_version: Option<String>,
    pub elapsed_ms: u64,
}
