import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  ConnectInfo,
  ConnectionProfile,
  ConnectionStore,
  CsvExportResult,
  ErDiagramData,
  ExportMode,
  FkInfo,
  FolderInfo,
  ImportCounts,
  JobStatus,
  KvKeyDetail,
  KvRunOutput,
  KvScanResult,
  LayoutEntry,
  QueryLogEntry,
  RunOutput,
  SavedSqlEntry,
  SchemaEntry,
  SessionSummary,
  SqlHistoryEntry,
  StartedJob,
  TableDetail,
  TableInfo,
  TestResult,
  ToolSettings,
  ToolStatus,
} from "./types";

export function listConnections(): Promise<ConnectionStore> {
  return invoke("list_connections");
}

export function createFolder(name: string): Promise<FolderInfo> {
  return invoke("create_folder", { name });
}

export function deleteFolder(id: string): Promise<void> {
  return invoke("delete_folder", { id });
}

export function updateLayout(
  folders: FolderInfo[],
  order: LayoutEntry[],
  rootOrder?: string[]
): Promise<void> {
  return invoke("update_layout", { folders, order, rootOrder });
}

export function saveConnection(
  profile: ConnectionProfile
): Promise<ConnectionProfile> {
  return invoke("save_connection", { profile });
}

export function deleteConnection(id: string): Promise<void> {
  return invoke("delete_connection", { id });
}

export function testConnection(
  profile: ConnectionProfile
): Promise<TestResult> {
  return invoke("test_connection", { profile });
}

export function connectSession(
  sessionId: string,
  profile: ConnectionProfile
): Promise<ConnectInfo> {
  return invoke("connect_session", { sessionId, profile });
}

export function listTables(
  sessionId: string,
  database: string
): Promise<TableInfo[]> {
  return invoke("list_tables", { sessionId, database });
}

export function tableDetail(
  sessionId: string,
  database: string,
  schema: string | undefined,
  table: string
): Promise<TableDetail> {
  return invoke("table_detail", { sessionId, database, schema, table });
}

export function disconnectSession(sessionId: string): Promise<void> {
  return invoke("disconnect_session", { sessionId });
}

export function runQuery(
  sessionId: string,
  database: string | undefined,
  sql: string,
  offset: number,
  orderBy?: string,
  orderDir?: string,
  transaction?: boolean,
  explain?: "explain" | "analyze"
): Promise<RunOutput> {
  return invoke("run_query", {
    sessionId,
    database,
    sql,
    offset,
    orderBy,
    orderDir,
    transaction: transaction ?? false,
    explain: explain ?? null,
  });
}

export function exportSchemaCsv(
  sessionId: string,
  database: string
): Promise<string[]> {
  return invoke("export_schema_csv", { sessionId, database });
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
  return invoke("export_query_csv", {
    sessionId,
    database,
    sql,
    jobId,
    orderBy,
    orderDir,
  });
}

/** CSV出力の進捗 (書き出し済み行数) を取得する。終了済みはnull */
export function csvExportStatus(jobId: string): Promise<number | null> {
  return invoke("csv_export_status", { jobId });
}

/** CSV出力をキャンセルする */
export function cancelCsvExport(jobId: string): Promise<void> {
  return invoke("cancel_csv_export", { jobId });
}

// ---------- 設定 > エクスポート/インポート ----------

/** 接続一覧をJSONファイルへ書き出す (件数を返す)。パスワードは含まれない */
export function exportConnections(path: string): Promise<number> {
  return invoke("export_connections", { path });
}

/** JSONファイルから接続一覧を取り込む */
export function importConnections(path: string): Promise<ImportCounts> {
  return invoke("import_connections", { path });
}

/** 全ER図をJSONファイルへ書き出す (件数を返す) */
export function exportErDiagrams(path: string): Promise<number> {
  return invoke("export_er_diagrams", { path });
}

/** JSONファイルからER図を取り込む (同名は上書き) */
export function importErDiagrams(path: string): Promise<ImportCounts> {
  return invoke("import_er_diagrams", { path });
}

/** SSH秘密鍵の参照ダイアログの初期フォルダ (~/.ssh または ホーム) を返す */
export function defaultSshKeyDir(): Promise<string> {
  return invoke("default_ssh_key_dir");
}

/** 実行結果キャプチャ(PNG)をDownloadsに保存し、保存先パスを返す */
export function saveCapture(
  fileName: string,
  dataBase64: string
): Promise<string> {
  return invoke("save_capture", { fileName, dataBase64 });
}

export function listSessions(): Promise<SessionSummary[]> {
  return invoke("list_sessions");
}

export function schemaSnapshot(
  sessionId: string,
  database: string
): Promise<SchemaEntry[]> {
  return invoke("schema_snapshot", { sessionId, database });
}

export function openDiff(): Promise<void> {
  return invoke("open_diff");
}

export function openSchema(
  sessionId: string,
  database: string,
  name?: string
): Promise<void> {
  return invoke("open_schema", { sessionId, database, name: name ?? null });
}

/** ER図ウィンドウを開く */
export function openEr(sessionId: string, database: string): Promise<void> {
  return invoke("open_er", { sessionId, database });
}

/** 指定DBの外部キー一覧を取得する (ER図用) */
export function foreignKeys(
  sessionId: string,
  database: string
): Promise<FkInfo[]> {
  return invoke("foreign_keys", { sessionId, database });
}

/** 保存済みER図を取得する (無ければnull) */
export function getErDiagram(key: string): Promise<ErDiagramData | null> {
  return invoke("get_er_diagram", { key });
}

/** ER図を保存する (キーごとに上書き) */
export function saveErDiagram(key: string, data: ErDiagramData): Promise<void> {
  return invoke("save_er_diagram", { key, data });
}

/** 保存済みER図の名前一覧を取得する */
export function listErDiagrams(): Promise<string[]> {
  return invoke("list_er_diagrams");
}

/** 保存済みER図を削除する */
export function deleteErDiagram(key: string): Promise<void> {
  return invoke("delete_er_diagram", { key });
}

export function openConsole(): Promise<void> {
  return invoke("open_console");
}

export function getQueryLog(afterSeq: number): Promise<QueryLogEntry[]> {
  return invoke("get_query_log", { afterSeq });
}

export function clearQueryLog(): Promise<void> {
  return invoke("clear_query_log");
}

// ---------- 外部ツール (エクスポート/インポート) ----------

export function getToolSettings(): Promise<ToolSettings> {
  return invoke("get_tool_settings");
}

export function saveToolSettings(settings: ToolSettings): Promise<void> {
  return invoke("save_tool_settings", { settings });
}

export function detectTools(): Promise<ToolStatus[]> {
  return invoke("detect_tools");
}

export function startExport(
  sessionId: string,
  database: string,
  tables: string[],
  mode: ExportMode
): Promise<StartedJob> {
  return invoke("start_export", { sessionId, database, tables, mode });
}

export function startImport(
  sessionId: string,
  database: string,
  filePath: string
): Promise<StartedJob> {
  return invoke("start_import", { sessionId, database, filePath });
}

export function jobStatus(jobId: string): Promise<JobStatus> {
  return invoke("job_status", { jobId });
}

/** 実行中のSQLをキャンセルする */
export function cancelQuery(sessionId: string): Promise<void> {
  return invoke("cancel_query", { sessionId });
}

// ---------- Valkey (KVモード) ----------

/** キー一覧をSCANで1ページぶん取得する */
export function kvScan(
  sessionId: string,
  database: string,
  pattern: string,
  cursor: string
): Promise<KvScanResult> {
  return invoke("kv_scan", { sessionId, database, pattern, cursor });
}

/** キーの詳細 (型・TTL・値プレビュー) を取得する */
export function kvKeyDetail(
  sessionId: string,
  database: string,
  key: string
): Promise<KvKeyDetail> {
  return invoke("kv_key_detail", { sessionId, database, key });
}

/** コマンド (複数行) を逐次実行する */
export function kvExec(
  sessionId: string,
  database: string,
  commands: string[]
): Promise<KvRunOutput> {
  return invoke("kv_exec", { sessionId, database, commands });
}

export function cancelJob(jobId: string): Promise<void> {
  return invoke("cancel_job", { jobId });
}

/** D&Dファイル転送用の一時ファイルを作成する */
export function createTempUpload(fileName: string): Promise<string> {
  return invoke("create_temp_upload", { fileName });
}

/** 一時ファイルへチャンクを追記する */
export function appendTempUpload(
  path: string,
  dataBase64: string
): Promise<void> {
  return invoke("append_temp_upload", { path, dataBase64 });
}

/** アプリ全般の設定を取得する */
export function getAppSettings(): Promise<AppSettings> {
  return invoke("get_app_settings");
}

/** アプリ全般の設定を保存する */
export function saveAppSettings(settings: AppSettings): Promise<void> {
  return invoke("save_app_settings", { settings });
}

/** SQL実行履歴を取得する (新しい順・最大100件) */
export function getSqlHistory(): Promise<SqlHistoryEntry[]> {
  return invoke("get_sql_history");
}

/** SQL実行履歴に追加する */
export function addSqlHistory(sql: string): Promise<void> {
  return invoke("add_sql_history", { sql });
}

/** 保存済みのSQLパラメータ値を取得する (パラメータ名 → 直近の値と埋め込み方) */
export function getSqlParams(): Promise<
  Record<string, { value: string; kind: string }>
> {
  return invoke("get_sql_params");
}

/** SQLパラメータ値を保存する (同名は上書き) */
export function saveSqlParams(
  entries: Record<string, { value: string; kind: string }>
): Promise<void> {
  return invoke("save_sql_params", { entries });
}

/** 保存SQLの一覧を取得する */
export function getSavedSql(): Promise<SavedSqlEntry[]> {
  return invoke("get_saved_sql");
}

/** 保存SQLを追加/更新する (idがnullなら新規)。更新後の全件を返す */
export function upsertSavedSql(
  id: string | null,
  name: string,
  folder: string,
  sql: string
): Promise<SavedSqlEntry[]> {
  return invoke("upsert_saved_sql", { id, name, folder, sql });
}

/** 保存SQLを削除する。削除後の全件を返す */
export function deleteSavedSql(id: string): Promise<SavedSqlEntry[]> {
  return invoke("delete_saved_sql", { id });
}
