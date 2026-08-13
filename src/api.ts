import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  ConnectInfo,
  ConnectionProfile,
  ConnectionStore,
  ExportMode,
  FolderInfo,
  JobStatus,
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
  order: LayoutEntry[]
): Promise<void> {
  return invoke("update_layout", { folders, order });
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

export function openSchema(sessionId: string, database: string): Promise<void> {
  return invoke("open_schema", { sessionId, database });
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
