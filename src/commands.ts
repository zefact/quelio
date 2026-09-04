/**
 * バックエンドのコマンド一覧 (名前と戻り値の型)。
 *
 * これまでは呼ぶたびに `invoke("名前")` と書き、戻り値の型もその場で
 * 決めていたため、Rust側の名前や戻り値が変わってもTypeScriptは気づけなかった。
 * 一覧をここ1か所に置き、呼び出しは必ず call() を通す。
 *
 * Rust側 (lib.rs の invoke_handler) との突き合わせは
 * commands.test.ts が行う (増減・改名はテストで落ちる)
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  CellValue,
  CharsetInfo,
  ConfigFile,
  ConnectInfo,
  ConnectionProfile,
  ConnectionStore,
  CsvDiffOverview,
  CsvDiffPage,
  CsvExportResult,
  CsvFindResult,
  CsvFromQuery,
  CsvSavedLayout,
  CsvInfo,
  CsvPage,
  CsvPreview,
  CsvSummary,
  CsvPos,
  DangerousStatement,
  ErDiagramData,
  ExportedLog,
  FkInfo,
  FolderInfo,
  ImportCounts,
  ImportResult,
  JobProgress,
  JobStatus,
  KvCountResult,
  KvDeleteResult,
  KvKeyDetail,
  KvRunOutput,
  KvScanResult,
  KvSearchResult,
  ObjectSearchResult,
  ProcessInfo,
  QueryLogEntry,
  RoutineInfo,
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
  TestDataColumn,
  TestDataResult,
  ToolSettings,
  ToolStatus,
  ValueSearchResult,
} from "./types";

/** コマンド名 → 戻り値の型 */
export interface CommandResults {
  add_sql_history: void;
  clear_sql_history: SqlHistoryEntry[];
  create_sample_database: string;
  create_saved_folder: SavedSqlStore;
  delete_saved_folder: SavedSqlStore;
  delete_sql_history: SqlHistoryEntry[];
  move_saved_node: SavedSqlStore;
  rename_saved_folder: SavedSqlStore;
  append_temp_upload: void;
  apply_column_ddl: string[];
  apply_foreign_key_ddl: string[];
  apply_index_ddl: string[];
  apply_row_change: string;
  cancel_csv_export: void;
  cancel_job: void;
  cancel_query: void;
  cancel_schema_load: void;
  change_schema: string[];
  check_config_files: ConfigFile[];
  check_dangerous_filled: DangerousStatement[];
  check_dangerous_sql: DangerousStatement[];
  check_kv_destructive: string[];
  clear_query_log: void;
  connect_session: ConnectInfo;
  count_query_rows: number;
  count_table_rows: number;
  create_database: string[];
  create_folder: FolderInfo;
  create_table: string[];
  create_temp_upload: string;
  csv_export_status: JobProgress | null;
  default_ssh_key_dir: string;
  delete_connection: void;
  delete_er_diagram: void;
  delete_folder: void;
  delete_saved_sql: SavedSqlStore;
  detect_tools: ToolStatus[];
  disconnect_session: void;
  drop_database: string[];
  drop_table: string[];
  end_txn: string;
  export_connections: number;
  export_er_diagrams: number;
  export_plan_csv: CsvExportResult;
  csv_open: CsvInfo;
  csv_open_fixed: CsvInfo;
  csv_set_fixed: CsvInfo;
  csv_layouts: CsvSavedLayout[];
  csv_save_layout: CsvSavedLayout[];
  csv_delete_layout: CsvSavedLayout[];
  csv_new: CsvInfo;
  csv_from_query: CsvFromQuery;
  csv_from_rows: CsvInfo;
  csv_close: void;
  csv_info: CsvInfo;
  csv_page: CsvPage;
  csv_set_cells: CsvInfo;
  csv_insert_rows: CsvInfo;
  csv_delete_rows: CsvInfo;
  csv_insert_col: CsvInfo;
  csv_delete_col: CsvInfo;
  csv_rename_col: CsvInfo;
  csv_find: CsvFindResult;
  csv_replace_all: CsvInfo;
  csv_undo: CsvInfo;
  csv_redo: CsvInfo;
  csv_set_header: CsvInfo;
  csv_set_format: CsvInfo;
  csv_save: CsvInfo;
  csv_export_xlsx: null;
  csv_summary: CsvSummary;
  csv_edge: CsvPos;
  csv_changed_outside: boolean;
  csv_dirty_names: string[];
  csv_compare: CsvDiffOverview;
  csv_guess_key: string[];
  csv_diff_page: CsvDiffPage;
  csv_diff_next: number | null;
  export_query_rows: CsvExportResult;
  export_query_log: ExportedLog;
  export_schema_csv: string[];
  export_schema_xlsx: string;
  fetch_cell: CellValue;
  generate_test_data: TestDataResult;
  get_app_settings: AppSettings;
  get_er_diagram: ErDiagramData | null;
  get_query_log: QueryLogEntry[];
  get_saved_sql: SavedSqlStore;
  get_sql_history: SqlHistoryEntry[];
  get_sql_params: Record<string, { value: string; kind: string }>;
  get_tool_settings: ToolSettings;
  get_txn_state: string;
  get_workspace: unknown | null;
  import_connections: ImportCounts;
  import_csv: ImportResult;
  import_er_diagrams: ImportCounts;
  job_status: JobStatus;
  kill_process: void;
  kv_apply: void;
  kv_count_keys: KvCountResult;
  kv_delete_keys: KvDeleteResult;
  kv_exec: KvRunOutput;
  kv_key_detail: KvKeyDetail;
  kv_scan: KvScanResult;
  kv_search: KvSearchResult;
  list_charsets: CharsetInfo[];
  list_collations: string[];
  list_column_types: string[];
  list_connections: ConnectionStore;
  list_er_diagrams: string[];
  list_pinned_tables: string[];
  list_processes: ProcessInfo[];
  list_routines: RoutineInfo[];
  list_schemas: string[];
  list_sessions: SessionSummary[];
  list_tables: TableInfo[];
  open_console: void;
  open_csv_window: void;
  open_main_window: void;
  open_diff: void;
  open_er: void;
  open_schema: void;
  plan_test_data: TestDataColumn[];
  preview_column_ddl: string[];
  preview_create_database: string;
  preview_create_schema: string;
  preview_create_table: string;
  preview_csv: CsvPreview;
  preview_sql: string;
  quarantine_config_file: string;
  rename_table: string[];
  reveal_path: void;
  run_query: RunOutput;
  save_app_settings: void;
  save_capture: string;
  save_text_file: string;
  save_text_as: void;
  save_connection: ConnectionProfile;
  save_er_diagram: void;
  save_sql_params: void;
  save_tool_settings: void;
  save_workspace: void;
  schema_columns: SchemaTable[];
  schema_snapshot: SchemaEntry[];
  schema_with_foreign_keys: { entries: SchemaEntry[]; foreignKeys: FkInfo[] };
  search_objects: ObjectSearchResult;
  search_values: ValueSearchResult;
  set_pinned_table: string[];
  set_table_comment: string[];
  split_sql_statements: string[];
  start_export: StartedJob;
  start_import: StartedJob;
  system_databases: string[];
  table_ddl: string;
  table_detail: TableDetail;
  test_connection: TestResult;
  trust_ssh_host: void;
  update_layout: void;
  upsert_saved_sql: SavedSqlStore;
}

/**
 * 実行時にも名前の一覧が要る (Rust側との突き合わせに使う) ので、
 * 型とは別に並べておく。
 * 下の _sameNames が、この2つのずれをコンパイル時に見つける
 */
export const COMMAND_NAMES = [
  "add_sql_history",
  "clear_sql_history",
  "create_sample_database",
  "create_saved_folder",
  "delete_saved_folder",
  "delete_sql_history",
  "move_saved_node",
  "rename_saved_folder",
  "append_temp_upload",
  "apply_column_ddl",
  "apply_foreign_key_ddl",
  "apply_index_ddl",
  "apply_row_change",
  "cancel_csv_export",
  "cancel_job",
  "cancel_query",
  "cancel_schema_load",
  "change_schema",
  "check_config_files",
  "check_dangerous_filled",
  "check_dangerous_sql",
  "check_kv_destructive",
  "clear_query_log",
  "connect_session",
  "count_query_rows",
  "count_table_rows",
  "create_database",
  "create_folder",
  "create_table",
  "create_temp_upload",
  "csv_changed_outside",
  "csv_close",
  "csv_compare",
  "csv_delete_col",
  "csv_delete_layout",
  "csv_delete_rows",
  "csv_diff_next",
  "csv_diff_page",
  "csv_dirty_names",
  "csv_export_status",
  "csv_find",
  "csv_from_query",
  "csv_from_rows",
  "csv_guess_key",
  "csv_info",
  "csv_insert_col",
  "csv_insert_rows",
  "csv_layouts",
  "csv_new",
  "csv_open",
  "csv_open_fixed",
  "csv_page",
  "csv_redo",
  "csv_rename_col",
  "csv_save_layout",
  "csv_replace_all",
  "csv_save",
  "csv_export_xlsx",
  "csv_summary",
  "csv_edge",
  "csv_set_cells",
  "csv_set_fixed",
  "csv_set_format",
  "csv_set_header",
  "csv_undo",
  "default_ssh_key_dir",
  "delete_connection",
  "delete_er_diagram",
  "delete_folder",
  "delete_saved_sql",
  "detect_tools",
  "disconnect_session",
  "drop_database",
  "drop_table",
  "end_txn",
  "export_connections",
  "export_er_diagrams",
  "export_plan_csv",
  "export_query_log",
  "export_query_rows",
  "export_schema_csv",
  "export_schema_xlsx",
  "fetch_cell",
  "generate_test_data",
  "get_app_settings",
  "get_er_diagram",
  "get_query_log",
  "get_saved_sql",
  "get_sql_history",
  "get_sql_params",
  "get_tool_settings",
  "get_txn_state",
  "get_workspace",
  "import_connections",
  "import_csv",
  "import_er_diagrams",
  "job_status",
  "kill_process",
  "kv_apply",
  "kv_count_keys",
  "kv_delete_keys",
  "kv_exec",
  "kv_key_detail",
  "kv_scan",
  "kv_search",
  "list_charsets",
  "list_collations",
  "list_column_types",
  "list_connections",
  "list_er_diagrams",
  "list_pinned_tables",
  "list_processes",
  "list_routines",
  "list_schemas",
  "list_sessions",
  "list_tables",
  "open_console",
  "open_csv_window",
  "open_main_window",
  "open_diff",
  "open_er",
  "open_schema",
  "plan_test_data",
  "preview_column_ddl",
  "preview_create_database",
  "preview_create_schema",
  "preview_create_table",
  "preview_csv",
  "preview_sql",
  "quarantine_config_file",
  "rename_table",
  "reveal_path",
  "run_query",
  "save_app_settings",
  "save_capture",
  "save_text_as",
  "save_text_file",
  "save_connection",
  "save_er_diagram",
  "save_sql_params",
  "save_tool_settings",
  "save_workspace",
  "schema_columns",
  "schema_snapshot",
  "schema_with_foreign_keys",
  "search_objects",
  "search_values",
  "set_pinned_table",
  "set_table_comment",
  "split_sql_statements",
  "start_export",
  "start_import",
  "system_databases",
  "table_ddl",
  "table_detail",
  "test_connection",
  "trust_ssh_host",
  "update_layout",
  "upsert_saved_sql",
] as const;

/** 上の2つが完全に一致していなければ、ここで型エラーになる */
type Missing = Exclude<keyof CommandResults, (typeof COMMAND_NAMES)[number]>;
type Extra = Exclude<(typeof COMMAND_NAMES)[number], keyof CommandResults>;
type Never<T extends never> = T;
export type _sameNames = Never<Missing | Extra>;

/**
 * バックエンドのコマンドを呼ぶ。
 *
 * 名前は上の一覧にあるものだけ、戻り値の型もそこから決まる。
 * 引数は画面ごとに形が違うので、この層 (api.ts) の関数で型を付ける
 */
export function call<K extends keyof CommandResults>(
  name: K,
  args?: Record<string, unknown>
): Promise<CommandResults[K]> {
  return invoke(name, args);
}
