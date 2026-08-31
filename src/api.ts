import { call } from "./commands";
import type {
  AppSettings,
  CellValue,
  CharsetInfo,
  ColumnChange,
  ConfigFile,
  ConnectInfo,
  ConnectionProfile,
  ConnectionStore,
  CsvExportResult,
  CsvOptions,
  CsvPreview,
  DangerousStatement,
  DbType,
  ErDiagramData,
  ExportedLog,
  ExportMode,
  ExportTable,
  FkInfo,
  FolderInfo,
  ForeignKeyChange,
  ImportCounts,
  ImportMode,
  ImportResult,
  IndexChange,
  JobProgress,
  JobStatus,
  KvChange,
  KvCountResult,
  KvDeleteResult,
  KvKeyDetail,
  KvRunOutput,
  KvScanResult,
  KvSearchOptions,
  KvSearchResult,
  LayoutEntry,
  LogFormat,
  NewTableSpec,
  ObjectSearchResult,
  ProcessAction,
  ProcessInfo,
  QueryLogEntry,
  RoutineInfo,
  RowCell,
  RowChange,
  RunOutput,
  SavedSqlStore,
  SchemaEntry,
  SchemaTable,
  SessionSummary,
  SqlHistoryEntry,
  StartedJob,
  TableDetail,
  TableInfo,
  TestResult,
  ToolSettings,
  ToolStatus,
  TxnStatus,
  ValueSearchOptions,
  ValueSearchResult,
} from "./types";
import type { ParamValue } from "./sqlParams";

export function listConnections(): Promise<ConnectionStore> {
  return call("list_connections");
}

/**
 * SSH踏み台のホスト鍵を信頼して記録する (初回接続の確認から呼ぶ)。
 * 記録しておくと、次からは鍵が変わったときだけ確認が出る
 */
export function trustSshHost(
  host: string,
  port: number,
  fingerprint: string
): Promise<void> {
  return call("trust_ssh_host", { host, port, fingerprint });
}

export function createFolder(name: string): Promise<FolderInfo> {
  return call("create_folder", { name });
}

export function deleteFolder(id: string): Promise<void> {
  return call("delete_folder", { id });
}

export function updateLayout(
  folders: FolderInfo[],
  order: LayoutEntry[],
  rootOrder?: string[]
): Promise<void> {
  return call("update_layout", { folders, order, rootOrder });
}

export function saveConnection(
  profile: ConnectionProfile
): Promise<ConnectionProfile> {
  return call("save_connection", { profile });
}

export function deleteConnection(id: string): Promise<void> {
  return call("delete_connection", { id });
}

export function testConnection(
  profile: ConnectionProfile
): Promise<TestResult> {
  return call("test_connection", { profile });
}

export function connectSession(
  sessionId: string,
  profile: ConnectionProfile
): Promise<ConnectInfo> {
  return call("connect_session", { sessionId, profile });
}

export function listTables(
  sessionId: string,
  database: string
): Promise<TableInfo[]> {
  return call("list_tables", { sessionId, database });
}

export function tableDetail(
  sessionId: string,
  database: string,
  schema: string | undefined,
  table: string
): Promise<TableDetail> {
  return call("table_detail", { sessionId, database, schema, table });
}

/**
 * 実行せずに、値を入れた後のSQLを返す (パラメータ入力画面のプレビュー用)。
 * 実行時と同じ処理を使うので、見えている内容と実際に走る内容がずれない
 */
export function previewSql(
  sessionId: string,
  sql: string,
  dbType: DbType,
  params: Record<string, ParamValue>
): Promise<string> {
  return call("preview_sql", { sessionId, sql, dbType, params });
}

/** 文字コード・照合順序の一覧 (データベース作成の選択肢) */
export function listCharsets(sessionId: string): Promise<CharsetInfo[]> {
  return call("list_charsets", { sessionId });
}

/** 実行せずに、データベースを作るSQLを返す (確認ダイアログに出す) */
export function previewCreateDatabase(
  dbType: DbType,
  name: string,
  encoding?: string,
  collation?: string
): Promise<string> {
  return call("preview_create_database", {
    dbType,
    name,
    encoding: encoding ?? null,
    collation: collation ?? null,
  });
}

/** 実行せずに、スキーマを作るSQLを返す (確認ダイアログに出す) */
export function previewCreateSchema(
  dbType: DbType,
  name: string
): Promise<string> {
  return call("preview_create_schema", { dbType, name });
}

/**
 * 画面に出ている実行計画をそのままCSVへ保存する。
 * 通常のCSV出力と違い、SQLは流し直さない
 */
export function exportPlanCsv(
  columns: string[],
  rows: (string | null)[][]
): Promise<CsvExportResult> {
  return call("export_plan_csv", { columns, rows });
}

/** 消してはいけないデータベースの名前 (画面で削除ボタンを出さないため) */
export function systemDatabases(dbType: DbType): Promise<string[]> {
  return call("system_databases", { dbType });
}

/** 設定フォルダのファイルが読める形かを確かめる */
export function checkConfigFiles(): Promise<ConfigFile[]> {
  return call("check_config_files");
}

/** 壊れた設定ファイルを退避する (退避先のパスを返す) */
export function quarantineConfigFile(name: string): Promise<string> {
  return call("quarantine_config_file", { name });
}

export function disconnectSession(sessionId: string): Promise<void> {
  return call("disconnect_session", { sessionId });
}

export function runQuery(
  sessionId: string,
  database: string | undefined,
  sql: string,
  offset: number,
  orderBy?: string,
  orderDir?: string,
  transaction?: boolean,
  explain?: "explain" | "analyze",
  /** SQL中の :name / @name に入れる値 (埋め込みはバックエンドで行う) */
  params?: Record<string, ParamValue>
): Promise<RunOutput> {
  return call("run_query", {
    sessionId,
    database,
    sql,
    offset,
    orderBy,
    orderDir,
    transaction: transaction ?? false,
    explain: explain ?? null,
    params: params ?? null,
  });
}

/** 入力どおりのテーブルを作成する。実行したSQLを返す */
export function createTable(
  sessionId: string,
  database: string | undefined,
  table: NewTableSpec
): Promise<string[]> {
  return call("create_table", { sessionId, database, table });
}

/** 実行せずに、テーブルを作るSQLを返す (確認ダイアログに出す) */
export function previewCreateTable(
  sessionId: string,
  database: string | undefined,
  table: NewTableSpec
): Promise<string> {
  return call("preview_create_table", { sessionId, database, table });
}

/** テーブル名を変更する。実行したSQLを返す */
export function renameTable(
  sessionId: string,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  newName: string
): Promise<string[]> {
  return call("rename_table", {
    sessionId,
    database,
    schema,
    table,
    newName,
  });
}

/** テーブル (ビュー) を削除する。実行したSQLを返す */
export function dropTable(
  sessionId: string,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  tableType: string
): Promise<string[]> {
  return call("drop_table", {
    sessionId,
    database,
    schema,
    table,
    tableType,
  });
}

/** テーブルのコメント (日本語名) を設定する。空文字で削除 */
export function setTableComment(
  sessionId: string,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  comment: string
): Promise<string[]> {
  return call("set_table_comment", {
    sessionId,
    database,
    schema,
    table,
    comment,
  });
}

/** 画面で切り詰められたセルの全文を読み直す (主キーで行を特定する) */
export function fetchCell(
  sessionId: string,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  column: string,
  key: RowCell[]
): Promise<CellValue> {
  return call("fetch_cell", {
    sessionId,
    database,
    schema,
    table,
    column,
    key,
  });
}

/** 外部キーの追加・削除を実行し、実行したSQLを返す */
export function applyForeignKeyDdl(
  sessionId: string,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  change: ForeignKeyChange
): Promise<string[]> {
  return call("apply_foreign_key_ddl", {
    sessionId,
    database,
    schema,
    table,
    change,
  });
}

/** 関数・プロシージャ・トリガの定義を取得する */
export function listRoutines(
  sessionId: string,
  database: string
): Promise<RoutineInfo[]> {
  return call("list_routines", { sessionId, database });
}

/** 預けたCSVファイルの先頭だけ読んで、列と数行を返す */
export function previewCsv(
  path: string,
  options: CsvOptions
): Promise<CsvPreview> {
  return call("preview_csv", { path, options });
}

/**
 * CSVをテーブルへ取り込む。
 *
 * @param mapping [CSVの何列目か, 取り込み先のカラム名] の並び
 * @param jobId 進捗の取得・中止に使うID
 */
export function importCsv(
  sessionId: string,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  path: string,
  options: CsvOptions,
  mapping: [number, string][],
  mode: ImportMode,
  emptyAsNull: boolean,
  jobId: string
): Promise<ImportResult> {
  return call("import_csv", {
    sessionId,
    database,
    schema,
    table,
    path,
    options,
    mapping,
    mode,
    emptyAsNull,
    jobId,
  });
}

// ---------- DB横断の検索 ----------

/**
 * テーブル名・カラム名・コメントから探す。
 *
 * MySQLはサーバー内の全データベースが対象。
 * PostgreSQLは指定したデータベースの全スキーマが対象 (他のDBは別接続が要るため範囲外)
 */
export function searchObjects(
  sessionId: string,
  database: string | undefined,
  keyword: string
): Promise<ObjectSearchResult> {
  return call("search_objects", { sessionId, database, keyword });
}

/**
 * 値の中から文字列を探す (選んだデータベースの中を総当たりする)。
 *
 * @param jobId 進捗の取得・中止に使うID
 */
export function searchValues(
  sessionId: string,
  database: string | undefined,
  options: ValueSearchOptions,
  jobId: string
): Promise<ValueSearchResult> {
  return call("search_values", { sessionId, database, options, jobId });
}

// ---------- Valkey: 一括削除と値検索 ----------

/**
 * パターンに一致するキーを数える (消す前の確認用。消しはしない)。
 *
 * @param jobId 進捗の取得・中止に使うID
 */
export function kvCountKeys(
  sessionId: string,
  database: string,
  pattern: string,
  jobId: string
): Promise<KvCountResult> {
  return call("kv_count_keys", { sessionId, database, pattern, jobId });
}

/**
 * パターンに一致するキーをまとめて消す。
 *
 * @param confirmedAll 全件が対象になると分かったうえで実行するか
 */
export function kvDeleteKeys(
  sessionId: string,
  database: string,
  pattern: string,
  confirmedAll: boolean,
  jobId: string
): Promise<KvDeleteResult> {
  return call("kv_delete_keys", {
    sessionId,
    database,
    pattern,
    confirmedAll,
    jobId,
  });
}

/** 値の中から文字列を探す */
export function kvSearch(
  sessionId: string,
  database: string,
  pattern: string,
  options: KvSearchOptions,
  jobId: string
): Promise<KvSearchResult> {
  return call("kv_search", {
    sessionId,
    database,
    pattern,
    options,
    jobId,
  });
}

// ---------- データベース / スキーマの管理 ----------

/** データベースを作る (作成後の一覧を返す) */
export function createDatabase(
  sessionId: string,
  name: string,
  encoding?: string,
  collation?: string
): Promise<string[]> {
  return call("create_database", { sessionId, name, encoding, collation });
}

/** データベースを消す (削除後の一覧を返す) */
export function dropDatabase(
  sessionId: string,
  name: string
): Promise<string[]> {
  return call("drop_database", { sessionId, name });
}

/** スキーマの一覧を取得する (PostgreSQLのみ) */
export function listSchemas(
  sessionId: string,
  database: string
): Promise<string[]> {
  return call("list_schemas", { sessionId, database });
}

/**
 * スキーマを作る / 消す (処理後の一覧を返す)。
 *
 * @param drop trueなら削除、falseなら作成
 * @param cascade 削除時に中身ごと消すか
 */
export function changeSchema(
  sessionId: string,
  database: string,
  name: string,
  drop: boolean,
  cascade: boolean
): Promise<string[]> {
  return call("change_schema", { sessionId, database, name, drop, cascade });
}

/**
 * サーバー側で動いている接続の一覧を取得する (読むだけ)。
 *
 * @param log コンソールに記録するか (数秒ごとの自動更新では記録しない)
 */
export function listProcesses(
  sessionId: string,
  database: string,
  log: boolean
): Promise<ProcessInfo[]> {
  return call("list_processes", { sessionId, database, log });
}

/** 他の接続のSQLを中止する / 接続を切る */
export function killProcess(
  sessionId: string,
  database: string,
  target: number,
  action: ProcessAction
): Promise<void> {
  return call("kill_process", { sessionId, database, target, action });
}

/** テーブルの正確な行数を数える (一覧の概算行数との差を確かめる) */
export function countTableRows(
  sessionId: string,
  database: string | undefined,
  schema: string | undefined,
  table: string
): Promise<number> {
  return call("count_table_rows", { sessionId, database, schema, table });
}

/** 保存したファイルの場所をOSのファイラで開く */
export function revealPath(path: string): Promise<void> {
  return call("reveal_path", { path });
}

/** テーブルの CREATE 文を取得する */
export function tableDdl(
  sessionId: string,
  database: string | undefined,
  schema: string | undefined,
  table: string
): Promise<string> {
  return call("table_ddl", { sessionId, database, schema, table });
}

/** データを1行だけ追加・更新・削除する。実行したSQLを返す */
export function applyRowChange(
  sessionId: string,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  change: RowChange
): Promise<string> {
  return call("apply_row_change", {
    sessionId,
    database,
    schema,
    table,
    change,
  });
}

/** SQLエディタの補完に使うテーブル・カラムの一覧を返す */
export function schemaColumns(
  sessionId: string,
  database: string
): Promise<SchemaTable[]> {
  return call("schema_columns", { sessionId, database });
}

/** カラムに使える型の一覧を返す (PostgreSQLはユーザー定義型も含む) */
export function listColumnTypes(
  sessionId: string,
  database: string
): Promise<string[]> {
  return call("list_column_types", { sessionId, database });
}

/** 使える照合順序の一覧を返す (MySQL / PostgreSQLのみ。他は空配列) */
export function listCollations(
  sessionId: string,
  database: string
): Promise<string[]> {
  return call("list_collations", { sessionId, database });
}

/** インデックスの追加・変更・削除を実行する。実行したSQLを返す */
export function applyIndexDdl(
  sessionId: string,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  change: IndexChange
): Promise<string[]> {
  return call("apply_index_ddl", {
    sessionId,
    database,
    schema,
    table,
    change,
  });
}

/** カラム変更のSQLを組み立てて返す (実行はしない) */
export function previewColumnDdl(
  sessionId: string,
  schema: string | undefined,
  table: string,
  change: ColumnChange
): Promise<string[]> {
  return call("preview_column_ddl", { sessionId, schema, table, change });
}

/** カラム変更を実行する (実行したSQLを返す) */
export function applyColumnDdl(
  sessionId: string,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  change: ColumnChange
): Promise<string[]> {
  return call("apply_column_ddl", {
    sessionId,
    database,
    schema,
    table,
    change,
  });
}

export function exportSchemaCsv(
  sessionId: string,
  database: string
): Promise<string[]> {
  return call("export_schema_csv", { sessionId, database });
}

/**
 * SQL実行結果 (1文ぶん) を全件CSVへ書き出す。
 * 画面のページング (1000行) とは無関係に、そのSQLの全行が対象
 */
export function exportQueryCsv(
  sessionId: string,
  database: string | undefined,
  sql: string,
  jobId: string,
  orderBy?: string,
  orderDir?: string
): Promise<CsvExportResult> {
  return call("export_query_csv", {
    sessionId,
    database,
    sql,
    jobId,
    orderBy,
    orderDir,
  });
}

/** CSV出力の進捗 (書き出し済み行数) を取得する。終了済みはnull */
export function csvExportStatus(jobId: string): Promise<JobProgress | null> {
  return call("csv_export_status", { jobId });
}

/** CSV出力をキャンセルする */
export function cancelCsvExport(jobId: string): Promise<void> {
  return call("cancel_csv_export", { jobId });
}

// ---------- 設定 > エクスポート/インポート ----------

/** 接続一覧をJSONファイルへ書き出す (件数を返す)。パスワードは含まれない */
export function exportConnections(path: string): Promise<number> {
  return call("export_connections", { path });
}

/** JSONファイルから接続一覧を取り込む */
export function importConnections(path: string): Promise<ImportCounts> {
  return call("import_connections", { path });
}

/** 全ER図をJSONファイルへ書き出す (件数を返す) */
export function exportErDiagrams(path: string): Promise<number> {
  return call("export_er_diagrams", { path });
}

/** JSONファイルからER図を取り込む (同名は上書き) */
export function importErDiagrams(path: string): Promise<ImportCounts> {
  return call("import_er_diagrams", { path });
}

/** SSH秘密鍵の参照ダイアログの初期フォルダ (~/.ssh または ホーム) を返す */
export function defaultSshKeyDir(): Promise<string> {
  return call("default_ssh_key_dir");
}

/** 実行結果キャプチャ(PNG)をDownloadsに保存し、保存先パスを返す */
export function saveCapture(
  fileName: string,
  dataBase64: string
): Promise<string> {
  return call("save_capture", { fileName, dataBase64 });
}

export function listSessions(): Promise<SessionSummary[]> {
  return call("list_sessions");
}

export function schemaSnapshot(
  sessionId: string,
  database: string
): Promise<SchemaEntry[]> {
  return call("schema_snapshot", { sessionId, database });
}

export function openDiff(): Promise<void> {
  return call("open_diff");
}

export function openSchema(
  sessionId: string,
  database: string,
  name?: string
): Promise<void> {
  return call("open_schema", { sessionId, database, name: name ?? null });
}

/** ER図ウィンドウを開く */
export function openEr(sessionId: string, database: string): Promise<void> {
  return call("open_er", { sessionId, database });
}

/** ER図用: スキーマと外部キーをまとめて取得する */
export function schemaWithForeignKeys(
  sessionId: string,
  database: string
): Promise<{ entries: SchemaEntry[]; foreignKeys: FkInfo[] }> {
  return call("schema_with_foreign_keys", { sessionId, database });
}

/** 前回の作業状態 (タブ・書きかけSQL) を取得する (無ければnull) */
export function getWorkspace(): Promise<unknown | null> {
  return call("get_workspace");
}

/** 作業状態を保存する (全上書き) */
export function saveWorkspace(data: unknown): Promise<void> {
  return call("save_workspace", { data });
}

/** 保存済みER図を取得する (無ければnull) */
export function getErDiagram(key: string): Promise<ErDiagramData | null> {
  return call("get_er_diagram", { key });
}

/** ER図を保存する (キーごとに上書き) */
export function saveErDiagram(key: string, data: ErDiagramData): Promise<void> {
  return call("save_er_diagram", { key, data });
}

/** 保存済みER図の名前一覧を取得する */
export function listErDiagrams(): Promise<string[]> {
  return call("list_er_diagrams");
}

/** 保存済みER図を削除する */
export function deleteErDiagram(key: string): Promise<void> {
  return call("delete_er_diagram", { key });
}

export function openConsole(): Promise<void> {
  return call("open_console");
}

/**
 * 実行前に確認したいSQL (DROP・TRUNCATE・WHERE無しのUPDATE/DELETE等) を調べる。
 * 実際の実行はしない。
 *
 * 文の区切り方はサーバーの設定で変わるため、判定にはセッションが実際に
 * 使っている方言を用いる (dbType は未接続時のフォールバック)
 */
export function checkDangerousSql(
  sessionId: string,
  sql: string,
  dbType: DbType
): Promise<DangerousStatement[]> {
  return call("check_dangerous_sql", { sessionId, sql, dbType });
}

/**
 * パラメータの値を入れた後のSQLが、確認の要る内容になっていないかを見る。
 *
 * 「そのまま」「数値」の値は囲まずに埋め込まれるので、
 * 値を入れて初めて危険になる場合がある (例: 条件に 1=1)
 */
export function checkDangerousFilled(
  sessionId: string,
  sql: string,
  dbType: DbType,
  params: Record<string, ParamValue>
): Promise<DangerousStatement[]> {
  return call("check_dangerous_filled", { sessionId, sql, dbType, params });
}

export function getQueryLog(afterSeq: number): Promise<QueryLogEntry[]> {
  return call("get_query_log", { afterSeq });
}

export function clearQueryLog(): Promise<void> {
  return call("clear_query_log");
}

/**
 * SQLログをファイルへ書き出す (保存先のフルパスを返す)。
 *
 * @param filter 画面の絞り込みと同じ条件 (空なら全件)
 */
export function exportQueryLog(
  filter: string,
  format: LogFormat
): Promise<ExportedLog> {
  return call("export_query_log", { filter, format });
}

// ---------- 外部ツール (エクスポート/インポート) ----------

export function getToolSettings(): Promise<ToolSettings> {
  return call("get_tool_settings");
}

export function saveToolSettings(settings: ToolSettings): Promise<void> {
  return call("save_tool_settings", { settings });
}

export function detectTools(): Promise<ToolStatus[]> {
  return call("detect_tools");
}

export function startExport(
  sessionId: string,
  database: string,
  tables: ExportTable[],
  mode: ExportMode
): Promise<StartedJob> {
  return call("start_export", { sessionId, database, tables, mode });
}

export function startImport(
  sessionId: string,
  database: string,
  filePath: string
): Promise<StartedJob> {
  return call("start_import", { sessionId, database, filePath });
}

export function jobStatus(jobId: string): Promise<JobStatus> {
  return call("job_status", { jobId });
}

/** スキーマの読み込み (専用接続) を中止する */
export function cancelSchemaLoad(sessionId: string): Promise<void> {
  return call("cancel_schema_load", { sessionId });
}

/** 実行中のSQLをキャンセルする */
export function cancelQuery(sessionId: string): Promise<void> {
  return call("cancel_query", { sessionId });
}

/**
 * 今のトランザクションの状態を読む。
 * 実行中は "busy" が返る (待たせないため。実行が終わったら読み直す)
 */
export function getTxnState(sessionId: string): Promise<TxnStatus> {
  return call("get_txn_state", { sessionId }) as Promise<TxnStatus>;
}

/** 開いているトランザクションを確定 / 取り消しする。閉じたあとの状態を返す */
export function endTxn(sessionId: string, commit: boolean): Promise<TxnStatus> {
  return call("end_txn", { sessionId, commit }) as Promise<TxnStatus>;
}

// ---------- Valkey (KVモード) ----------

/** キー一覧をSCANで1ページぶん取得する */
export function kvScan(
  sessionId: string,
  database: string,
  pattern: string,
  cursor: string
): Promise<KvScanResult> {
  return call("kv_scan", { sessionId, database, pattern, cursor });
}

/** キーの詳細 (型・TTL・値プレビュー) を取得する */
export function kvKeyDetail(
  sessionId: string,
  database: string,
  key: string
): Promise<KvKeyDetail> {
  return call("kv_key_detail", { sessionId, database, key });
}

/** Valkey: キーの値を変更する (追加・削除・改名・TTL変更・新規作成) */
export function kvApply(
  sessionId: string,
  database: string,
  change: KvChange
): Promise<void> {
  return call("kv_apply", { sessionId, database, change });
}

/** コマンド (複数行) を逐次実行する */
export function kvExec(
  sessionId: string,
  database: string,
  commands: string[],
  confirmed = false
): Promise<KvRunOutput> {
  return call("kv_exec", { sessionId, database, commands, confirmed });
}

/**
 * 実行前に確認したいValkeyコマンド (FLUSHALL・CONFIG SET等) を1つ返す。
 * 無ければnull
 */
export function checkKvDestructive(commands: string[]): Promise<string[]> {
  return call("check_kv_destructive", { commands });
}

export function cancelJob(jobId: string): Promise<void> {
  return call("cancel_job", { jobId });
}

/** D&Dファイル転送用の一時ファイルを作成する */
export function createTempUpload(fileName: string): Promise<string> {
  return call("create_temp_upload", { fileName });
}

/** 一時ファイルへチャンクを追記する */
export function appendTempUpload(
  path: string,
  dataBase64: string
): Promise<void> {
  return call("append_temp_upload", { path, dataBase64 });
}

/** アプリ全般の設定を取得する */
export function getAppSettings(): Promise<AppSettings> {
  return call("get_app_settings");
}

/** 設定が保存されたことを同じウィンドウ内の画面へ伝えるイベント名 */
export const APP_SETTINGS_EVENT = "quelio-app-settings-changed";

/** アプリ全般の設定を保存する */
export async function saveAppSettings(settings: AppSettings): Promise<void> {
  await call("save_app_settings", { settings });
  // 設定はモーダルで変えるため、開いたままの画面へ変更を知らせる
  window.dispatchEvent(new CustomEvent(APP_SETTINGS_EVENT));
}

/** SQL実行履歴を取得する (新しい順・最大100件) */
export function getSqlHistory(): Promise<SqlHistoryEntry[]> {
  return call("get_sql_history");
}

/** SQL実行履歴に追加する */
export function addSqlHistory(sql: string): Promise<void> {
  return call("add_sql_history", { sql });
}

/** 履歴を1件消す。残りの全件を返す */
export function deleteSqlHistory(sql: string): Promise<SqlHistoryEntry[]> {
  return call("delete_sql_history", { sql });
}

/** 履歴をすべて消す (空の一覧が返る) */
export function clearSqlHistory(): Promise<SqlHistoryEntry[]> {
  return call("clear_sql_history");
}

/** 保存済みのSQLパラメータ値を取得する (パラメータ名 → 直近の値と埋め込み方) */
export function getSqlParams(
  scope: string
): Promise<Record<string, { value: string; kind: string }>> {
  return call("get_sql_params", { scope });
}

/** SQLパラメータ値を保存する (接続ごと。同名は上書き) */
export function saveSqlParams(
  scope: string,
  entries: Record<string, { value: string; kind: string }>
): Promise<void> {
  return call("save_sql_params", { scope, entries });
}

/** 保存SQLの一覧を取得する */
export function getSavedSql(): Promise<SavedSqlStore> {
  return call("get_saved_sql");
}

/** 保存SQLを追加/更新する (idがnullなら新規)。更新後の全件を返す */
export function upsertSavedSql(
  id: string | null,
  name: string,
  folder: string,
  sql: string
): Promise<SavedSqlStore> {
  return call("upsert_saved_sql", { id, name, folder, sql });
}

/** 保存SQLを削除する。削除後の全体を返す */
export function deleteSavedSql(id: string): Promise<SavedSqlStore> {
  return call("delete_saved_sql", { id });
}

/** お気に入りのフォルダを作る (空のままでも残る) */
export function createSavedFolder(path: string): Promise<SavedSqlStore> {
  return call("create_saved_folder", { path });
}

/** フォルダの名前を変える (中身のパスも付け替わる) */
export function renameSavedFolder(
  path: string,
  name: string
): Promise<SavedSqlStore> {
  return call("rename_saved_folder", { path, name });
}

/** フォルダを中身ごと削除する */
export function deleteSavedFolder(path: string): Promise<SavedSqlStore> {
  return call("delete_saved_folder", { path });
}

/**
 * フォルダ・項目を移す (ドラッグでの並べ替え)。
 *
 * @param node "f:<フォルダのパス>" か "i:<項目のID>"
 * @param parent 移動先のフォルダ ("" = ルート)
 * @param before この要素の直前へ入れる (null なら末尾)
 */
export function moveSavedNode(
  node: string,
  parent: string,
  before: string | null
): Promise<SavedSqlStore> {
  return call("move_saved_node", { node, parent, before });
}
