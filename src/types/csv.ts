/**
 * CSVエディタ (別ウィンドウ) の型。
 *
 * 全行はRust側が持っているので、ここに出てくるのは
 * 「今の状態のまとめ」と「見えている範囲の行」だけになる
 */

/** 改行コード */
export type CsvNewline = "lf" | "crlf";

/** 引用符の付け方 */
export type CsvQuoting = "necessary" | "always";

// ---------- 固定長 ----------

/** 桁幅の数え方 */
export type CsvWidthUnit = "byte" | "char";

/** 桁の中で値を寄せる向き */
export type CsvAlign = "left" | "right";

/** 桁1つ */
export interface CsvFixedColumn {
  /** 桁の幅 (単位はレイアウト側の unit に従う) */
  width: number;
  align: CsvAlign;
  /** 余りを埋める文字 (空白か 0) */
  pad: string;
  /** 項目名 (固定長のファイルには見出しが無いのでここで持つ) */
  name: string;
}

/** ファイル1つぶんの桁の並び */
export interface CsvFixedLayout {
  unit: CsvWidthUnit;
  columns: CsvFixedColumn[];
  /** 読むときに埋め文字を落とすか */
  trim: boolean;
}

/** 固定長として読むときの指定 */
export interface CsvFixedSpec {
  unit: CsvWidthUnit;
  /** 幅だけ決めるとき (詰め方は中身から見分ける) */
  widths?: number[] | null;
  /** 残してあるレイアウトを使うとき */
  layout?: CsvFixedLayout | null;
}

/** 名前を付けて残した桁の並び */
export interface CsvSavedLayout {
  name: string;
  layout: CsvFixedLayout;
  updatedAtMs: number;
}

/** ファイルの形 (開いたときの状態。保存の既定にもなる) */
export interface CsvFormat {
  /** 文字コードの名前 ("UTF-8" / "Shift_JIS" など) */
  encoding: string;
  /** BOMを付けるか */
  bom: boolean;
  newline: CsvNewline;
  /** 区切り文字 (1文字) */
  delimiter: string;
  quoting: CsvQuoting;
  /** 固定長として読んでいるときの桁 (区切り文字のときは null) */
  fixed: CsvFixedLayout | null;
}

/** 開いているCSV1つの状態 */
export interface CsvInfo {
  docId: string;
  /** タブに出す名前 */
  name: string;
  /** 保存先 (まだ保存していなければ null) */
  path: string | null;
  format: CsvFormat;
  /** 1行目をヘッダとして扱っているか */
  hasHeader: boolean;
  /** 列名 (ヘッダとして扱っていなければ "1", "2", …) */
  columns: string[];
  rowCount: number;
  /** 保存していない編集があるか */
  dirty: boolean;
  /** 行によって列数が違っていたか (足りない分は空欄で埋めてある) */
  ragged: boolean;
  /** 文字コードの変換で置き換えが起きたか (文字化けの疑い) */
  replaced: boolean;
  /** 取り消せる操作の名前 (無ければ null) */
  undoLabel: string | null;
  /** やり直せる操作の名前 (無ければ null) */
  redoLabel: string | null;
}

/** クエリ結果をCSVタブとして開いた結果 */
export interface CsvFromQuery {
  /** 開いたタブ (中止したときは null) */
  info: CsvInfo | null;
  /** 取り出した行数 */
  rows: number;
  cancelled: boolean;
}

/** 1ページぶんの行 */
export interface CsvPage {
  offset: number;
  rows: string[][];
  /** 全体の行数 (スクロールバーの長さに使う) */
  total: number;
}

/** 保存する形の変更 (渡したものだけ変わる) */
export interface CsvFormatPatch {
  encoding?: string;
  bom?: boolean;
  newline?: CsvNewline;
  delimiter?: string;
  quoting?: CsvQuoting;
}

/** 書き換えるセル1つ */
export interface CsvCellPatch {
  row: number;
  col: number;
  value: string;
}

// ---------- 検索・置換 ----------

/** 探し方 */
export interface CsvFindOptions {
  /** 英字の大小を区別する */
  matchCase: boolean;
  /** セルの中身がまるごと同じものだけを対象にする */
  wholeCell: boolean;
  /** この列だけを見る (null なら全部の列) */
  column: number | null;
}

/** 見つかったセルの位置 */
export interface CsvMatch {
  row: number;
  col: number;
}

/** 探した結果 */
export interface CsvFindResult {
  /** 見つかった場所 (無ければ null) */
  hit: CsvMatch | null;
  /** 引っかかったセルの数 */
  total: number;
}

// ---------- 比較 ----------

/** 突き合わせ方 */
export type CsvDiffMode = "key" | "set";

/** 突き合わせの条件 */
export interface CsvDiffOptions {
  mode: CsvDiffMode;
  /** キーにする列の名前 (mode が "key" のときだけ使う) */
  key: string[];
  /** 前後の空白を無視して比べる */
  trim: boolean;
  /** 英字の大小を無視して比べる */
  ignoreCase: boolean;
}

/** 行の突き合わせ結果 */
export type CsvRowStatus = "same" | "changed" | "onlyLeft" | "onlyRight";

/** 左右の列の対応 (片側にしか無い列は反対側が null) */
export interface CsvColumnPair {
  name: string;
  left: number | null;
  right: number | null;
}

/** 件数のまとめ */
export interface CsvDiffSummary {
  same: number;
  changed: number;
  onlyLeft: number;
  onlyRight: number;
}

/** 突き合わせの結果のまとめ (行そのものはページで取りに行く) */
export interface CsvDiffOverview {
  columns: CsvColumnPair[];
  summary: CsvDiffSummary;
  /** 画面に出す行数 (一致した行も含む) */
  total: number;
  /** キーが重複していた件数 */
  duplicateKeys: number;
  /** 片側にしか無い列があったか */
  columnMismatch: boolean;
}

/** 差分の1行 (左右の値つき) */
export interface CsvDiffRow {
  status: CsvRowStatus;
  /** 左の行位置 (無ければ null = 右にしか無い行) */
  left: number | null;
  right: number | null;
  /** 値が違った列 (columns の並びでの位置) */
  changed: number[];
  /** columns の並びでの左の値 (行が無ければ空配列) */
  leftCells: string[];
  rightCells: string[];
}

/** 差分の1ページ */
export interface CsvDiffPage {
  offset: number;
  rows: CsvDiffRow[];
  total: number;
}

/** 選んでいる範囲の要約 (情報バーに出す) */
export interface CsvSummary {
  /** 選んでいるセルの数 */
  cells: number;
  /** 中身の入っているセルの数 (空欄は数えない) */
  filled: number;
  /** すべて数値なら、その合計 (数値以外が混ざるなら null) */
  sum: string | null;
}

/** セルの位置 (端まで飛んだ先) */
export interface CsvPos {
  row: number;
  col: number;
}

/** 選んでいる四角 (端を含む) */
export interface CsvRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}
