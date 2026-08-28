/**
 * SQLの実行と、その結果。
 * 結果の表・進捗・ログ・履歴・行の編集・実行中の接続
 */

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

/**
 * お気に入りの全体 (フォルダと項目)。
 *
 * フォルダは項目のパスから起こすのではなく一覧で持つ。
 * 空のフォルダを先に作れるようにするため
 */
export interface SavedSqlStore {
  /** フォルダのパス一覧 (同じ親の中では、この並びが表示順) */
  folders: string[];
  /** 保存したSQL (同じフォルダの中では、この並びが表示順) */
  items: SavedSqlEntry[];
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
