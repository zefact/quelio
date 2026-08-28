/** 対応DB種別 (sqliteはファイルベースで、databaseにファイルパスを入れる) */
export type DbType = "mysql" | "postgresql" | "sqlite" | "valkey";

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  keyPath: string;
  passphrase?: string;
}

/** MySQL / PostgreSQL のTLSの使い方 */
export type SslMode = "" | "disable" | "require" | "verify-ca" | "verify-full";

/** TLSの選択肢 (値 → 画面に出す説明) */
export const SSL_MODES: [SslMode, string][] = [
  ["", "既定 (使えれば使う。証明書は検証しない)"],
  ["disable", "使わない"],
  ["require", "必須 (検証なし)"],
  ["verify-ca", "必須 + CA証明書を検証"],
  ["verify-full", "必須 + CA証明書とホスト名を検証"],
];

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
  /**
   * MySQL / PostgreSQL のTLSの使い方。
   * 未設定はドライバの既定 (使えれば使う・証明書は検証しない)
   */
  sslMode?: SslMode;
  /** サーバー証明書の検証に使うCA証明書 (PEM) のパス */
  caCertPath?: string;
  /** クライアント証明書 (PEM) のパス */
  clientCertPath?: string;
  /** クライアント証明書の秘密鍵 (PEM) のパス */
  clientKeyPath?: string;
  /** 読み取り専用で接続する (更新系の操作をすべて拒否する) */
  readOnly?: boolean;
  ssh?: SshConfig;
  /** 所属フォルダID (未設定ならルート直下) */
  folderId?: string;
  /** アイコン色 (#rrggbb。未設定ならDB種別ごとの既定色) */
  color?: string;
  /**
   * 保存されたパスワード・パスフレーズを復号できなかった。
   * (マスターキーが変わった等) この場合は接続できないため、入力し直してもらう
   */
  passwordLocked?: boolean;
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
  /** ルート階層の表示順 (フォルダIDとフォルダ未所属の接続IDが混在)。
   *  未設定なら「フォルダ → 接続」の順で表示する */
  rootOrder?: string[];
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
  /** PostgreSQL: このテーブル自身の分け方 (`RANGE (at)` など) */
  partitionBy?: string | null;
  /** PostgreSQL: パーティションの子なら [親テーブル名 (引用済み), 範囲の指定] */
  partitionOf?: [string, string] | null;
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
  /** MySQLの接頭辞インデックスの長さ (columns の並びと対応。無ければnull) */
  subParts?: (number | null)[];
  indexType?: string;
  cardinality?: number;
  /** 主キー・UNIQUE制約に紐づくインデックス (画面からは変更できない) */
  constrained: boolean;
}

/** インデックスの追加・変更で指定する内容 */
export interface IndexSpec {
  name: string;
  unique: boolean;
  /** 対象カラム (並び順どおり) */
  columns: string[];
  /** 種別 (空ならDBの既定。MySQL: BTREE/HASH/FULLTEXT/SPATIAL) */
  indexType?: string;
}

/** インデックスに対する変更内容 (バックエンドでSQLに変換する) */
export type IndexChange =
  | { kind: "add"; index: IndexSpec }
  | { kind: "drop"; name: string }
  | { kind: "modify"; before: string; index: IndexSpec };

/** Valkeyの値ビュー1行 (1列目=field / 2列目=value) */
export interface KvRow {
  field: string;
  value: string;
}

/** Valkeyのキーに対する変更内容 */
export type KvChange =
  | { kind: "update"; key: string; kvType: string; before: KvRow; after: KvRow }
  | { kind: "insert"; key: string; kvType: string; row: KvRow }
  | { kind: "remove"; key: string; kvType: string; row: KvRow }
  | { kind: "deleteKey"; key: string }
  | { kind: "rename"; key: string; newKey: string }
  /** ttlは秒。0以下で無期限に戻す */
  | { kind: "expire"; key: string; ttl: number }
  | { kind: "createKey"; key: string; kvType: string; row: KvRow };

/** SQLエディタの補完に使うカラム (名前と型) */
export interface SchemaColumn {
  name: string;
  /** 表示用の型名 (取れない場合は空) */
  dataType: string;
  /** カラムコメント (日本語名の取り出しに使う。SQLiteは常に空) */
  comment: string;
}

/** SQLエディタの補完に使うテーブル */
export interface SchemaTable {
  name: string;
  /** テーブルコメント (日本語名の取り出しに使う。SQLiteは常に空) */
  comment: string;
  columns: SchemaColumn[];
}

export interface TableDetail {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  /** このテーブルから出ている外部キー */
  foreignKeys: ForeignKeyInfo[];
  info: [string, string][];
}

/** 長すぎて切り詰められたセルの位置 (バックエンドの ClippedCell と対) */
export interface ClippedCell {
  /** このページの中での行番号 (0始まり) */
  row: number;
  /** 列番号 (0始まり) */
  col: number;
  /** 注記を除いた、実際に入っている先頭の文字数 */
  head: number;
  /** 切り詰める前の全体の文字数 */
  total: number;
}

export interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
  /**
   * 切り詰められたセルの位置。
   * 値そのものにも「… (全N文字)」が付いているが、
   * 判定は必ずこちらで行う (文言に依存させない)
   */
  clipped?: ClippedCell[];
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

/**
 * 時間のかかる処理の局面 (バックエンドの JobPhase と対)。
 *
 * 件数だけを見せていると、COMMIT / ROLLBACK の間は数字が止まったまま
 * 「取り込み中」と出続けてしまう
 */
export type JobPhase = "working" | "committing" | "rollingBack";

/** 時間のかかる処理の進捗 */
export interface JobProgress {
  /** ここまでに処理した件数 */
  rows: number;
  phase: JobPhase;
}

/** SQL実行結果のCSV出力結果 */
export interface CsvExportResult {
  /** 保存したファイルのフルパス (キャンセル時は空) */
  path: string;
  /** 書き出した行数 (ヘッダ行は含まない) */
  rows: number;
  /** 途中でキャンセルされたか (この場合ファイルは残らない) */
  cancelled: boolean;
}

/** 複数文実行の全体結果 */
export interface RunOutput {
  statements: StatementResult[];
  error?: string;
  failedIndex?: number;
}

/** 設定のバックアップ/復元の取り込み結果 */
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

/** SQLログを書き出す形式 */
export type LogFormat = "csv" | "text";

/** SQLログを書き出した結果 */
export interface ExportedLog {
  /** 保存したファイルのフルパス */
  path: string;
  /** 書き出した件数 */
  rows: number;
}

/** 設定フォルダのファイル1件の状態 (バックエンドの ConfigFile と対) */
export interface ConfigFile {
  /** ファイル名 (退避のときに指定する) */
  name: string;
  /** 画面に出す名前 */
  label: string;
  /** 実際のパス */
  path: string;
  exists: boolean;
  /** 読めない理由 (読めるなら null) */
  error: string | null;
}

export interface TestResult {
  success: boolean;
  message: string;
  serverVersion?: string;
  elapsedMs: number;
}

/** カラム変更 (DDL) で指定する、変更後 (または追加する) カラムの内容 */
export interface ColumnSpec {
  name: string;
  /** 型 (例: varchar(100)) */
  colType: string;
  nullable: boolean;
  /** デフォルト値の式 (空なら指定なし)。値はそのままSQLへ埋め込まれる */
  default?: string;
  /** カラムコメント (MySQL / PostgreSQLのみ) */
  comment?: string;
  /** 照合順序 (MySQL / PostgreSQLのみ。空ならDBの既定) */
  collation?: string;
  /** MySQLのみ: 位置。"FIRST" で先頭、カラム名ならその直後 */
  after?: string;
  /** MySQLのみ: AUTO_INCREMENT等の属性。変更時に引き継ぐために送る */
  extra?: string;
}

/** 新しく作るテーブルの指定 (バックエンドでCREATE TABLEに変換する) */
export interface NewTableSpec {
  /** スキーマ (PostgreSQLのみ。空なら検索パス任せ) */
  schema?: string;
  name: string;
  columns: ColumnSpec[];
  /** 主キーにするカラム名 (並べた順のまま複合キーになる) */
  primaryKey: string[];
  /** 既定の文字コード (MySQLのみ) */
  charset?: string;
  /** 既定の照合順序 (MySQLのみ) */
  collation?: string;
  /** テーブルコメント (MySQL / PostgreSQLのみ) */
  comment?: string;
}

/** カラムに対する変更内容 (バックエンドでSQLに変換する) */
export type ColumnChange =
  | { kind: "add"; column: ColumnSpec }
  | { kind: "drop"; name: string }
  | { kind: "modify"; before: ColumnSpec; column: ColumnSpec };

/** データ編集で扱う1カラム分の値 (NULLはnull) */
export interface RowCell {
  column: string;
  value: string | null;
}

/** データの1行に対する変更内容 (バックエンドでSQLに変換する) */
/** セル1つの取得結果 (行が無い場合と値がNULLの場合を区別する) */
export interface CellValue {
  /** 対象の行が見つかったか */
  found: boolean;
  /** 値 (NULLならnull) */
  value: string | null;
}

export type RowChange =
  | { kind: "update"; key: RowCell[]; set: RowCell[] }
  | { kind: "insert"; values: RowCell[] }
  | { kind: "delete"; key: RowCell[] };

/** テーブル選択時の表示タブ (定義 / データ) */
export type TableTab = "definition" | "data";

/** 1タブの状態。未接続なら接続選択画面、接続後はDBブラウザになる */
/** Valkeyキーブラウザの状態 (タブを切り替えても復元できるように保持する) */
export interface KvBrowseState {
  /** この内容がどのDB番号のものか (DB切替時に誤って復元しないため) */
  db: string;
  pattern: string;
  keys: KvKeyInfo[];
  /** SCANの続きを読むためのカーソル */
  cursor: string;
  done: boolean;
  dbsize: number;
  selectedKey: string | null;
}

/** SQLエディタの実行設定 (タブ切替で失わないようタブ側で保持する) */
export interface EditorOptions {
  /** トランザクション (BEGIN 〜 COMMIT/ROLLBACK) で実行する */
  txn: boolean;
  /** 実行後にSQLと結果のPNGを保存する */
  capture: boolean;
  /** 実行ボタンの対象 (全体 / 選択部分) */
  runMode: "all" | "selection";
  /** EXPLAINボタンのモード */
  explainMode: "explain" | "analyze";
  /** エディタを画面いっぱいに広げているか */
  editorFull: boolean;
}

export function defaultEditorOptions(): EditorOptions {
  return {
    txn: false,
    capture: false,
    runMode: "all",
    explainMode: "explain",
    editorFull: false,
  };
}

/** 接続し直したあとに戻す先 (作業状態の復元に使う) */
export interface RestoreTarget {
  /** この接続先のときだけ復元する (別の接続に変えたら捨てる) */
  profileId: string;
  db: string | null;
  table: string | null;
}

/**
 * SQLエディタの1シート (書きかけのSQLと、その実行結果)。
 *
 * 1つの接続で「検証用のSELECT」と「本命のUPDATE」を並べて持てるようにする。
 * 接続は1本なので同時には実行できず、実行中はシートを切り替えない
 */
export interface QuerySheet {
  id: string;
  /** 見出し (空ならSQLの先頭から作る) */
  title: string;
  sql: string;
  queryResults: StatementResult[] | null;
  queryError: string | null;
  queryExplain: "explain" | "analyze" | null;
  editorOpts: EditorOptions;
}

/** 空のシートを作る */
export function emptySheet(id: string): QuerySheet {
  return {
    id,
    title: "",
    sql: "",
    queryResults: null,
    queryError: null,
    queryExplain: null,
    editorOpts: defaultEditorOptions(),
  };
}

/**
 * SQLエディタまわりの状態 (WorkTab の中でひとまとまりにして持つ)。
 *
 * 表示中のシートの内容は sql / queryResults などの側にあり、
 * `sheets` の同じIDの要素は切り替えるまで古いままになる
 */
export interface TabEditorState {
  sql: string;
  queryResults: StatementResult[] | null;
  queryError: string | null;
  /** 直前の実行がEXPLAIN系だったか (結果ヘッダの説明表示に使う) */
  queryExplain: "explain" | "analyze" | null;
  /** 実行設定 (トランザクション等)。タブ単位で保持する */
  editorOpts: EditorOptions;
  running: boolean;
  /** 実行開始時刻 (epoch ms)。タブ切替で再マウントされても経過表示を続けるために持つ */
  startedAt: number | null;
  /** 全シート (表示中のものも含む) */
  sheets: QuerySheet[];
  /** 表示中のシートのID */
  activeSheet: string;
}

/** 空のエディタ状態を作る (シート1枚から始める) */
export function emptyEditorState(): TabEditorState {
  // 「表示中のシートは必ず一覧にいる」を最初から満たしておく
  const first = emptySheet(newSheetId());
  return {
    sql: "",
    queryResults: null,
    queryError: null,
    queryExplain: null,
    editorOpts: defaultEditorOptions(),
    running: false,
    startedAt: null,
    sheets: [first],
    activeSheet: first.id,
  };
}

/** Valkey画面の状態 (WorkTab の中でひとまとまりにして持つ) */
export interface TabKvState {
  /** コンソールの実行結果 */
  results?: KvStatementResult[];
  /** コンソールのエラー表示 */
  execError?: string | null;
  /** キーブラウザの状態 (タブ切替後もそのまま戻せるように持つ) */
  browse?: KvBrowseState;
}

/** データタブの状態 (WorkTab の中でひとまとまりにして持つ) */
export interface TabTableData {
  /** 取得済みの1ページぶん (未取得はnull) */
  data: QueryResult | null;
  loading: boolean;
  error: string | null;
  /** 絞り込み条件 (WHERE句。空なら全件) */
  where: string;
}

export function emptyTableData(): TabTableData {
  return { data: null, loading: false, error: null, where: "" };
}

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
  /** データタブの状態 (まとめて画面へ渡す) */
  tableData: TabTableData;
  /** SQL結果ヘッダ用のカラム説明 (カラム名(小文字) → 論理名・補足・型) */
  columnTips: Record<string, string>;
  /** columnTipsを読み込み済みのDB名 (未読込はnull) */
  columnTipsDb: string | null;
  /** 接続後の右ペイン表示 (構造 or SQLエディタ) */
  view: "structure" | "query";
  /** SQLエディタまわり (まとめて画面へ渡す) */
  editor: TabEditorState;
  error: string | null;
  testResult: TestResult | null;
  busy: "test" | "save" | "connect" | null;
  /** Valkey画面の状態 (タブを切り替えても保持する) */
  kv: TabKvState;
  /** 前回終了時に開いていたDB・テーブル (接続できたら戻す。復元後に消す) */
  restore?: RestoreTarget;
}

/** シートのIDを作る (タブをまたいでも衝突しない程度でよい) */
export function newSheetId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
    tableData: emptyTableData(),
    kv: {},
    columnTips: {},
    columnTipsDb: null,
    view: "structure",
    editor: emptyEditorState(),
    error: null,
    testResult: null,
    busy: null,
  };
}

export const DEFAULT_PORTS: Record<DbType, number> = {
  mysql: 3306,
  postgresql: 5432,
  // SQLiteはファイルを直接開くためポートを使わない
  sqlite: 0,
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

/** SQLダンプ出力・SQLファイル実行の進捗 */
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

/** SQLダンプに含める範囲 */
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
  /** 各種ファイル (キャプチャ・CSV・SQLダンプ等) の保存先フォルダ。
   * 空文字ならOSのダウンロードフォルダ */
  downloadDir: string;
  /** SQLエディタの入力補完を使うか */
  autocompleteEnabled: boolean;
  /** 入力補完が自動で開くまでの待ち時間 (ミリ秒)。0なら自動では開かない */
  autocompleteDelayMs: number;
  /** ALTER・RENAME (定義の変更) も実行前に確認するか */
  confirmAlter: boolean;
  /** 起動時に前回のタブ (接続先と書きかけのSQL) を復元するか */
  restoreTabs: boolean;
}

/** 実行前に確認したいSQL (DROP・WHERE無しのUPDATE等) */
export interface DangerousStatement {
  /** 定義を変えるだけの種類か (ALTER / RENAME)。設定で確認を省ける対象 */
  definitionChange: boolean;
  /** 種類の説明 (画面にそのまま出す) */
  kind: string;
  /** 対象のSQL (長い場合は先頭のみ) */
  sql: string;
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

/** SQLダンプ出力の対象テーブル (PostgreSQLはスキーマ付き) */
export interface ExportTable {
  schema?: string;
  name: string;
}

/** 関数・プロシージャ・トリガ1件 (定義の表示用) */
export interface RoutineInfo {
  /** 種別 (関数 / プロシージャ / トリガ など) */
  kind: string;
  /** スキーマ (MySQL・SQLiteは空) */
  schema: string;
  name: string;
  /** 引数や対象テーブルなどの補足 */
  detail: string;
  /** CREATE文 */
  definition: string;
}

/** CSV取り込みの読み取り設定 */
export interface CsvOptions {
  /** "," / "\t" など。未指定なら中身から推測する */
  delimiter?: string;
  /** "utf-8" / "shift_jis"。未指定なら中身から推測する */
  encoding?: string;
  /** 1行目を見出しとして扱うか */
  hasHeader: boolean;
}

/** 取り込み方法 */
export type ImportMode = "append" | "skip" | "replace";

/** CSVの先頭だけ読んだ内容 */
export interface CsvPreview {
  /** 列の見出し (見出し行が無ければ「1列目」のような仮の名前) */
  columns: string[];
  /** 先頭の数行 */
  rows: string[][];
  /** 実際に使った区切り文字 */
  delimiter: string;
  /** 実際に使った文字コード */
  encoding: string;
  /** 読み取り中に見つかった問題 */
  warning: string | null;
}

/** 取り込みの結果 */
export interface ImportResult {
  rows: number;
  /** 中止したか (中止した場合は何も入っていない) */
  cancelled: boolean;
}

/** 名前で探した結果の1件 */
/** 文字コード1件と、そこで使える照合順序 (バックエンドの CharsetInfo と対) */
export interface CharsetInfo {
  name: string;
  /** 読みやすい説明 (PostgreSQLでは空) */
  description: string;
  /** 何も選ばなかったときに使われる照合順序 (PostgreSQLでは空) */
  defaultCollation: string;
  /** この文字コードで使える照合順序 (PostgreSQLでは空) */
  collations: string[];
}

/** 名前検索の結果 (バックエンドの ObjectSearchResult と対) */
export interface ObjectSearchResult {
  hits: ObjectHit[];
  /** 上限に達して打ち切った */
  truncated: boolean;
}

export interface ObjectHit {
  /** MySQLはデータベース名、PostgreSQLは接続中のDB名 */
  database: string;
  /** PostgreSQLのスキーマ (他は空) */
  schema: string;
  table: string;
  /** カラム名 (テーブル自体が一致したときは空) */
  column: string;
  dataType: string;
  comment: string;
}

/** 値で探した結果の1件 */
export interface ValueHit {
  schema: string;
  table: string;
  column: string;
  /** 見つかった値の先頭 */
  value: string;
  /**
   * DB側の照合順序のほうが広くて当たった行 (全角と半角を同じとみなす等)。
   * どの列で当たったのかまでは分からない
   */
  approximate: boolean;
}

/** 値検索の結果 */
export interface ValueSearchResult {
  hits: ValueHit[];
  /** 見に行ったテーブル数 */
  scanned: number;
  cancelled: boolean;
  /** 上限に達して打ち切った */
  truncated: boolean;
  /** 読めなかったテーブル (権限が無いなど) */
  skipped: string[];
}

/** 値検索の条件 */
export interface ValueSearchOptions {
  needle: string;
  /** 大文字小文字を区別しない */
  ignoreCase: boolean;
}

/** パターンに一致するキーを数えた結果 */
export interface KvCountResult {
  /** 一致したキーの数 */
  total: number;
  /** 先頭いくつかのキー名 */
  sample: string[];
  cancelled: boolean;
  /** 上限まで読んだので、まだ先がある */
  truncated: boolean;
}

/** キーの一括削除の結果 */
export interface KvDeleteResult {
  deleted: number;
  cancelled: boolean;
  truncated: boolean;
}

/** 値検索の当たり */
export interface KvSearchHit {
  key: string;
  type: string;
  /** 当たった場所 (hashのフィールド名・listの位置など) */
  field: string;
  /** 当たった値の先頭 */
  preview: string;
}

/** 値検索の結果 */
export interface KvSearchResult {
  hits: KvSearchHit[];
  /** 見に行ったキーの数 */
  scanned: number;
  cancelled: boolean;
  /** 上限に達して打ち切った */
  truncated: boolean;
}

/** 値検索の条件 */
export interface KvSearchOptions {
  /** 探す文字列 */
  needle: string;
  /** 大文字小文字を区別しない */
  ignoreCase: boolean;
  /** キー名も探す対象にする */
  includeKeys: boolean;
}

/** サーバー側で動いている接続1本ぶんの情報 */
export interface ProcessInfo {
  /** 接続ID (MySQL) / プロセスID (PostgreSQL)。中止・切断に使う */
  id: number;
  user: string;
  /** 接続元 (host:port など) */
  host: string;
  database: string;
  /** 状態 (Sleep / Query / active / idle in transaction など) */
  state: string;
  /** その状態になってからの秒数 */
  seconds: number;
  /** 実行中のSQL (空なら何も走っていない) */
  query: string;
  /** この画面自身の接続か */
  isSelf: boolean;
}

/** 実行中クエリへの操作 */
export type ProcessAction = "cancel" | "terminate";

/** テーブルに付いている外部キー1件 */
export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  /** 参照先のスキーマ (MySQL・SQLiteは空) */
  refSchema: string;
  refTable: string;
  refColumns: string[];
  /** ON DELETE の動作 (空ならDBの既定) */
  onDelete: string;
  /** ON UPDATE の動作 (空ならDBの既定) */
  onUpdate: string;
}

/** 追加する外部キーの内容 */
export interface ForeignKeySpec {
  /** 制約名 (空ならDBに任せる) */
  name?: string;
  columns: string[];
  /** 参照先のスキーマ (空なら同じスキーマ) */
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

/** 外部キーに対する変更内容 */
export type ForeignKeyChange =
  | { kind: "add"; fk: ForeignKeySpec }
  | { kind: "drop"; name: string };
