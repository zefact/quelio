export type DbType = "mysql" | "postgresql";

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  keyPath: string;
  passphrase?: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  dbType: DbType;
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  ssh?: SshConfig;
  /** 所属フォルダID (未設定ならルート直下) */
  folderId?: string;
  /** アイコン色 (#rrggbb。未設定ならDB種別ごとの既定色) */
  color?: string;
}

export interface FolderInfo {
  id: string;
  name: string;
  collapsed: boolean;
  /** アイコン色 (#rrggbb。未設定なら既定のアンバー) */
  color?: string;
}

/** 保存される接続先一式 (配列順 = 表示順) */
export interface ConnectionStore {
  folders: FolderInfo[];
  connections: ConnectionProfile[];
}

/** 並べ替え保存用エントリ */
export interface LayoutEntry {
  id: string;
  folderId?: string;
}

export interface ConnectInfo {
  databases: string[];
  currentDb?: string;
  /** サーバー情報 (ラベルと値の組) */
  serverInfo: [string, string][];
}

export interface TableInfo {
  schema?: string;
  name: string;
  tableType: string;
  rowEstimate?: number;
}

export interface ColumnInfo {
  name: string;
  colType: string;
  nullable: boolean;
  key?: string;
  default?: string;
  extra?: string;
  collation?: string;
  comment?: string;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string;
  indexType?: string;
  cardinality?: number;
}

export interface TableDetail {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  info: [string, string][];
}

export interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
  /** このページの先頭行のオフセット */
  offset: number;
  /** 次のページが存在するか */
  hasMore: boolean;
  /** ページング可能なクエリだったか */
  pageable: boolean;
  /** サーバーサイドソート中のカラム名 */
  orderBy?: string;
  /** サーバーサイドソートの方向 (asc / desc) */
  orderDir?: string;
  rowsAffected?: number;
  elapsedMs: number;
}

/** 1ページの行数 (バックエンドのPAGE_SIZEと一致させる) */
export const QUERY_PAGE_SIZE = 1000;

/** 1文ぶんの実行結果 */
export interface StatementResult {
  sql: string;
  result: QueryResult;
}

/** 複数文実行の全体結果 */
export interface RunOutput {
  statements: StatementResult[];
  error?: string;
  failedIndex?: number;
}

/** スキーマスナップショットの1テーブル分 */
export interface SchemaEntry {
  table: TableInfo;
  detail: TableDetail;
}

/** 開いているセッションの概要 (差分ビューア用) */
export interface SessionSummary {
  sessionId: string;
  name: string;
  dbType: DbType;
  databases: string[];
  currentDb?: string;
}

export interface QueryLogEntry {
  seq: number;
  time: string;
  connection: string;
  database: string;
  query: string;
}

export interface TestResult {
  success: boolean;
  message: string;
  serverVersion?: string;
  elapsedMs: number;
}

/** 1タブの状態。未接続なら接続選択画面、接続後はDBブラウザになる */
export interface WorkTab {
  /** タブ固有キー (バックエンドのセッションIDと同一) */
  key: string;
  /** 編集中 or 接続中のプロファイル */
  profile: ConnectionProfile;
  connected: boolean;
  databases: string[];
  /** 接続先サーバーの情報 (バージョン・文字コード等) */
  serverInfo: [string, string][];
  selectedDb: string | null;
  tables: TableInfo[];
  loadingTables: boolean;
  selectedTable: string | null;
  tableDetail: TableDetail | null;
  loadingDetail: boolean;
  /** 接続後の右ペイン表示 (構造 or SQLエディタ) */
  view: "structure" | "query";
  sql: string;
  queryResults: StatementResult[] | null;
  queryError: string | null;
  /** 直前の実行がEXPLAIN系だったか (結果ヘッダの説明表示に使う) */
  queryExplain: "explain" | "analyze" | null;
  runningQuery: boolean;
  /** 実行開始時刻 (epoch ms)。タブ切替で再マウントされても経過表示を継続するために保持 */
  runStartedAt: number | null;
  error: string | null;
  testResult: TestResult | null;
  busy: "test" | "save" | "connect" | null;
}

export function emptyTab(key: string): WorkTab {
  return {
    key,
    profile: emptyProfile(),
    connected: false,
    databases: [],
    serverInfo: [],
    selectedDb: null,
    tables: [],
    loadingTables: false,
    selectedTable: null,
    tableDetail: null,
    loadingDetail: false,
    view: "structure",
    sql: "",
    queryResults: null,
    queryError: null,
    queryExplain: null,
    runningQuery: false,
    runStartedAt: null,
    error: null,
    testResult: null,
    busy: null,
  };
}

export const DEFAULT_PORTS: Record<DbType, number> = {
  mysql: 3306,
  postgresql: 5432,
};

export function emptyProfile(): ConnectionProfile {
  return {
    id: "",
    name: "",
    dbType: "mysql",
    host: "localhost",
    port: DEFAULT_PORTS.mysql,
    user: "",
    password: "",
    database: "",
    ssh: emptySsh(),
  };
}

export function emptySsh(): SshConfig {
  return {
    enabled: false,
    host: "",
    port: 22,
    user: "",
    keyPath: "",
    passphrase: "",
  };
}

/** 外部ツール(mysqldump等)のパス設定 (空文字=自動検出) */
export interface ToolSettings {
  mysqldump: string;
  mysql: string;
  pgDump: string;
  psql: string;
}

/** 外部ツールの検出結果 */
export interface ToolStatus {
  tool: string;
  path: string | null;
  version: string | null;
  fromSettings: boolean;
}

/** エクスポート/インポートジョブの進捗 */
export interface JobStatus {
  running: boolean;
  error: string | null;
  bytes: number;
  total: number | null;
  outPath: string | null;
  cancelled: boolean;
}

/** ジョブ開始結果 */
export interface StartedJob {
  jobId: string;
  outPath: string | null;
}

/** エクスポート範囲 */
export type ExportMode = "full" | "schema" | "data";

/** テーブル構造ビューのコメント表示方法 */
export type StructureCommentMode = "comment" | "split";

/** アプリ全般の設定 (一般タブ) */
export interface AppSettings {
  /** カラムコメントを論理名＋補足に分解する区切り文字 */
  commentDelimiter: string;
  /** テーブル構造ビューのコメント表示 (comment=そのまま / split=論理名＋補足) */
  structureCommentMode: StructureCommentMode;
  /** SQL結果に行番号を表示するか */
  showRowNumbers: boolean;
  /** SQL実行のタイムアウト (秒)。0で無制限 */
  queryTimeoutSecs: number;
}

/** SQL実行履歴の1件 */
export interface SqlHistoryEntry {
  sql: string;
  /** 実行日時 (UNIXエポックms) */
  executedAtMs: number;
}

/** 保存SQLの1件 */
export interface SavedSqlEntry {
  id: string;
  name: string;
  /** フォルダパス ("" = ルート、"/"区切りで階層) */
  folder: string;
  sql: string;
  /** 更新日時 (UNIXエポックms) */
  updatedAtMs: number;
}
