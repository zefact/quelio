/**
 * アプリ全体の設定と、時間のかかる処理の状態。
 * CSVの取り込み設定・外部ツール・バックアップもここ
 */

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

/** カンマの位置 (leading=次の行の先頭 / trailing=その行の末尾) */
export type SqlCommaStyle = "leading" | "trailing";

/** 語の大文字小文字 (preserve=書いたまま) */
export type SqlWordCase = "upper" | "lower" | "preserve";

/** 字下げの1段ぶん */
export type SqlIndent = "2" | "4" | "tab";

/** AND・OR の位置 (before=行の先頭 / after=行の末尾) */
export type SqlLogicalNewline = "before" | "after";

/**
 * 字下げのスタイル。
 * standard=段ごとに字下げ / tabularLeft・tabularRight=キーワードの幅を揃える
 */
export type SqlIndentStyle = "standard" | "tabularLeft" | "tabularRight";

/** JOIN の ON の置き方 (same=JOINと同じ行 / newline=次の行に出して条件を下げる) */
export type SqlOnClause = "same" | "newline";

/** SQLエディタの「整形」ボタンの書式 */
export interface SqlFormatSettings {
  commaStyle: SqlCommaStyle;
  keywordCase: SqlWordCase;
  indent: SqlIndent;
  logicalNewline: SqlLogicalNewline;
  indentStyle: SqlIndentStyle;
  onClause: SqlOnClause;
}

/** 整形の既定 (今までの固定の書き方と同じ形になる) */
export function defaultSqlFormat(): SqlFormatSettings {
  return {
    commaStyle: "leading",
    keywordCase: "upper",
    indent: "2",
    logicalNewline: "before",
    indentStyle: "standard",
    onClause: "newline",
  };
}

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
  /** 起動時に前回の書きかけSQL (SQLシートと名前) を復元するか */
  restoreSheets: boolean;
  /** SQLエディタの「整形」ボタンの書式 */
  sqlFormat: SqlFormatSettings;
}

/** 設定のバックアップ/復元の取り込み結果 */
export interface ImportCounts {
  added: number;
  updated: number;
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
