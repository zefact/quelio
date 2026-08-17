export type DbType = "mysql" | "postgresql" | "valkey";

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
  /** TLSで接続する (Valkey用。AWS ElastiCache等のin-transit暗号化) */
  tls?: boolean;
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

/** 設定のエクスポート/インポートの取り込み結果 */
export interface ImportCounts {
  added: number;
  updated: number;
}

/** スキーマスナップショットの1テーブル分 */
export interface SchemaEntry {
  table: TableInfo;
  detail: TableDetail;
}

/** 開いているセッションの概要 (差分ビューア用) */
export interface SessionSummary {
  sessionId: string;
  /** 接続プロファイルのID (ER図の保存キーなどに使う) */
  profileId: string;
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

/** テーブル選択時の表示タブ (定義 / データ) */
export type TableTab = "definition" | "data";

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
  /** テーブル画面で表示中のタブ (定義 / データ)。テーブルを切り替えても維持する */
  tableTab: TableTab;
  /** データタブの1ページぶんの結果 */
  tableData: QueryResult | null;
  loadingData: boolean;
  dataError: string | null;
  /** データタブの絞り込み条件 (WHERE句) */
  dataWhere: string;
  /** SQL結果ヘッダ用のカラム説明 (カラム名(小文字) → 論理名・補足・型) */
  columnTips: Record<string, string>;
  /** columnTipsを読み込み済みのDB名 (未読込はnull) */
  columnTipsDb: string | null;
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
  /** Valkeyコンソールの実行結果 (タブを切り替えても保持する) */
  kvResults?: KvStatementResult[];
  /** Valkeyコンソールのエラー表示 */
  kvExecError?: string | null;
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
    tableTab: "definition",
    tableData: null,
    loadingData: false,
    dataError: null,
    dataWhere: "",
    columnTips: {},
    columnTipsDb: null,
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
  valkey: 6379,
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
    tls: false,
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
  /** 各種ファイル (キャプチャ・CSV・エクスポート等) の保存先フォルダ。
   * 空文字ならOSのダウンロードフォルダ */
  downloadDir: string;
}

/** SQL実行履歴の1件 */
export interface SqlHistoryEntry {
  sql: string;
  /** 実行日時 (UNIXエポックms) */
  executedAtMs: number;
}

/** 外部キーの1件 (ER図用) */
export interface FkInfo {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

/** テーブル境界上の接続位置 (辺 + 辺に沿った割合0〜1)。
 * 割合で持つことでテーブルのサイズが変わっても相対位置を保つ */
export interface ErAnchorPoint {
  side: "top" | "bottom" | "left" | "right";
  t: number;
}

/** 線の見た目 (線種・色)。未設定は破線・既定色 */
export interface ErEdgeStyle {
  style?: "solid" | "dashed" | "dotted";
  /** #rrggbb (未設定は既定のインディゴ) */
  color?: string;
}

/** 手動で追加したER図のリレーション */
export interface ErCustomEdge {
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
}

/** ER図上の注釈要素 (枠 or テキスト見出し) */
export interface ErFrame {
  id: string;
  /** 要素の種類 (box=枠 / text=テキストのみ。未指定はbox) */
  kind?: "box" | "text";
  /** 表示するテキスト */
  label: string;
  /** 枠線の種類 (none=枠線なし) */
  style: "solid" | "dashed" | "dotted" | "none";
  /** 枠線の色 (hex。未指定はグレー) */
  color?: string;
  /** 角丸にするか (未指定はtrue=角丸) */
  rounded?: boolean;
  /** 背景色 (hex。未指定は透明) */
  fill?: string;
  /** テーブルより前面に表示するか (未指定はfalse=背面) */
  front?: boolean;
  /** テキストの文字サイズ (px。kind=text用。未指定は18) */
  fontSize?: number;
  /** テキストの文字色 (hex。kind=text用。未指定はグレー) */
  textColor?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** ER図の1ページ (タブ) 分の内容 */
export interface ErPageData {
  id: string;
  /** タブに表示する名前 */
  name: string;
  entries: SchemaEntry[];
  fks: FkInfo[];
  /** テーブル名 → 位置 (左上座標) */
  positions: Record<string, { x: number; y: number }>;
  /** 表示オプション */
  options?: {
    allCols: boolean;
    showLogical: boolean;
    showTypes: boolean;
  };
  /** 削除した自動検出リレーションのキー (from.col->to.col) */
  removedEdges?: string[];
  /** 図から削除したテーブル名 (リバースしても再追加しない) */
  removedTables?: string[];
  /** テーブルごとの横幅の上書き (px。未設定は内容に合わせて自動) */
  tableWidths?: Record<string, number>;
  /** 手動で追加したリレーション */
  customEdges?: ErCustomEdge[];
  /** 線ごとの接続位置の上書き (キーはfrom.col->to.col形式) */
  anchors?: Record<string, { from?: ErAnchorPoint; to?: ErAnchorPoint }>;
  /** 線に対応するカラムの追加分 (複合キーなど複数カラムの対応に使う)。
   * 線を選択したとき代表カラムに加えてここのカラムもハイライトされる */
  edgeColumns?: Record<string, { from: string[]; to: string[] }>;
  /** 線ごとの見た目 (線種・色。キーはfrom.col->to.col形式) */
  edgeStyles?: Record<string, ErEdgeStyle>;
  /** 注釈枠 */
  frames?: ErFrame[];
}

/** 保存されるER図データ (1ファイル = 複数ページ) */
export interface ErDiagramData {
  savedAtMs: number;
  /** ページ (タブ) 一覧。旧形式のデータには無い */
  pages?: ErPageData[];
  /** 最後に開いていたページのindex */
  activePage?: number;
  // ---- 以下は旧形式 (単一ページ) のフィールド。読み込み時の移行用 ----
  entries?: SchemaEntry[];
  fks?: FkInfo[];
  positions?: Record<string, { x: number; y: number }>;
  options?: {
    allCols: boolean;
    showLogical: boolean;
    showTypes: boolean;
  };
  removedEdges?: string[];
  removedTables?: string[];
  tableWidths?: Record<string, number>;
  customEdges?: ErCustomEdge[];
  anchors?: Record<string, { from?: ErAnchorPoint; to?: ErAnchorPoint }>;
  edgeColumns?: Record<string, { from: string[]; to: string[] }>;
  edgeStyles?: Record<string, ErEdgeStyle>;
  frames?: ErFrame[];
}

// ---------- Valkey (KVモード) ----------

/** キー一覧の1件 */
export interface KvKeyInfo {
  key: string;
  type: string;
  /** 残りTTL秒 (-1: 無期限 / -2: 消滅) */
  ttl: number;
}

/** SCAN 1ページぶんの結果 */
export interface KvScanResult {
  entries: KvKeyInfo[];
  /** 続きを読むカーソル ("0"で終端) */
  cursor: string;
  done: boolean;
  /** 選択中DBの総キー数 */
  dbsize: number;
}

/** キー詳細 (型・TTL・値プレビュー) */
export interface KvKeyDetail {
  key: string;
  type: string;
  ttl: number;
  memory: number | null;
  encoding: string | null;
  /** 総要素数 (stringはバイト長) */
  total: number;
  /** 値ビューの列ラベル */
  cols: [string, string];
  rows: [string, string][];
  truncated: boolean;
}

/** コマンド1つの実行結果 */
export interface KvStatementResult {
  command: string;
  /** redis-cli風の整形済み出力 */
  lines: string[];
  elapsedMs: number;
}

/** コマンド実行 (複数行) の全体結果 */
export interface KvRunOutput {
  statements: KvStatementResult[];
  error?: string;
  failedIndex?: number;
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
