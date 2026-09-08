/**
 * CSVエディタ (別ウィンドウ) の型。
 *
 * 全行はRust側が持っているので、ここに出てくるのは
 * 「今の状態のまとめ」と「見えている範囲の行」だけになる
 */

/** 改行コード */
export type CsvNewline = "lf" | "crlf";

/** 引用符に使う文字 */
export type CsvQuote = "none" | "double" | "single";

/** 引用符を付ける範囲 */
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

/**
 * レコードの種別を、値で見分ける決まり。
 *
 * ヘッダ行とボディ行が交互に来るファイルのためのもの
 */
export interface CsvFixedKey {
  /** 見る位置 (レコードの先頭からいくつ目か。0始まり) */
  at: number;
  /** 見る長さ */
  len: number;
  /** この値ならヘッダ行 */
  header: string;
}

/**
 * レコードの種別1つ。
 *
 * 「決まった場所がこの値ならこの桁で切る」という決まりと、その桁の並び。
 * 種別はいくつでも足せて、見る場所は種別ごとに違ってよい
 */
export interface CsvFixedKind {
  /** 画面に出す名前 (「ヘッダ」「明細」など) */
  name: string;
  /** 見る位置 (レコードの先頭からいくつ目か。0始まり) */
  at: number;
  /** 見る長さ */
  len: number;
  /** この値ならこの種別 */
  value: string;
  /** この種別の桁の並び */
  columns: CsvFixedColumn[];
}

/** ファイル1つぶんの桁の並び */
export interface CsvFixedLayout {
  unit: CsvWidthUnit;
  columns: CsvFixedColumn[];
  /** 読むときに埋め文字を落とすか */
  trim: boolean;
  /**
   * 行が改行で区切られているか。
   *
   * false のときは、ファイルに改行が無く、桁の合計ぶんずつが1行になる
   */
  newline: boolean;
  /**
   * 先頭のヘッダレコードの桁 (空なら「ヘッダは無い」)。
   *
   * データ行とは項目の分け方も長さも違うことがあるので、桁の並びごと別に持つ
   */
  header: CsvFixedColumn[];
  /** 末尾のトレーラレコードの桁 (空なら「トレーラは無い」) */
  trailer: CsvFixedColumn[];
  /**
   * レコードの種別 (空なら見分けない)。
   *
   * 上から順に見て、はじめに当てはまった種別の桁で切る。
   * どれにも当てはまらないレコードは `columns` の桁で切る。
   * ヘッダが2種類あるファイルなどは、ここに並べて決める
   */
  kinds: CsvFixedKind[];
  /**
   * 古い形の決まり (ヘッダ1種類だけを見分けていたころのもの)。
   *
   * 読み込むときに `kinds` へ直されるので、新しく作るときは使わない
   */
  key?: CsvFixedKey | null;
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

/**
 * お気に入りの一覧に並ぶもの。
 *
 * フォルダは1階層まで (フォルダの中にフォルダは入らない)。
 * フォルダに入れていないお気に入りは、一番上の並びにそのまま置く
 */
export type CsvLayoutNode =
  | { kind: "folder"; name: string; items: CsvSavedLayout[] }
  | ({ kind: "item" } & CsvSavedLayout);

/** ファイルの形 (開いたときの状態。保存の既定にもなる) */
export interface CsvFormat {
  /** 文字コードの名前 ("UTF-8" / "Shift_JIS" など) */
  encoding: string;
  /** BOMを付けるか */
  bom: boolean;
  newline: CsvNewline;
  /** 区切り文字 (1文字) */
  delimiter: string;
  /** 引用符に使う文字 */
  quote: CsvQuote;
  /** 引用符を付ける範囲 */
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
  /** 画面に出る行数 (絞り込み中は絞ったあとの数) */
  rowCount: number;
  /** ファイル全体の行数 (絞り込みと関係なく数えた数) */
  totalRows: number;
  /** 列ごとの絞り込み (空なら絞っていない) */
  filters: CsvColumnFilter[];
  /** 並べ替え (していなければ null) */
  sort: CsvSort | null;
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
  /** 固定長のヘッダレコードの値 (無ければ空) */
  headRow: string[];
  /** 固定長のトレーラレコードの値 (無ければ空) */
  trailerRow: string[];
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
  /** 画面に出る行数 (スクロールバーの長さに使う) */
  total: number;
  /**
   * このページの各行の種別 (種別を見分けているときだけ入る)。
   *
   * 0 はどの種別にも当てはまらないふつうのデータ行
   */
  kinds: number[];
  /**
   * このページの各行が、元のファイルの何行目か (0から数える)。
   *
   * 絞り込んでいるときだけ入る (絞っていなければ offset から順に並ぶ)
   */
  numbers: number[];
}

/** 保存する形の変更 (渡したものだけ変わる) */
export interface CsvFormatPatch {
  encoding?: string;
  bom?: boolean;
  newline?: CsvNewline;
  delimiter?: string;
  quote?: CsvQuote;
  quoting?: CsvQuoting;
}

/** 貼り付けた結果 (画面の知らせに使う) */
export interface CsvPasteResult {
  /** 貼り付けたあとの状態 */
  info: CsvInfo;
  /** 実際に入れた行数・列数 */
  rows: number;
  cols: number;
  /** 足りなくて増やした行数 */
  addedRows: number;
  /** 右にはみ出して切り落とした列があったか */
  clippedCols: boolean;
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
  /** 正規表現として扱う */
  regex: boolean;
  /** 探す範囲 (空なら表全体) */
  areas: CsvRect[];
}

// ---------- 絞り込み ----------

/** 絞り込みの条件の種類 */
export type CsvFilterKind =
  | "contains"
  | "notContains"
  | "equals"
  | "notEquals"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "ge"
  | "lt"
  | "le"
  | "empty"
  | "notEmpty";

/** 絞り込みの条件1つ */
export interface CsvFilterRule {
  kind: CsvFilterKind;
  value: string;
}

/** 1つの列の絞り込み */
export interface CsvColumnFilter {
  col: number;
  /** 選んだ値 (null なら値では絞らない) */
  values: string[] | null;
  /** 条件 (空なら条件では絞らない) */
  rules: CsvFilterRule[];
  /** 条件どうしを「かつ」で見るか (false なら「または」) */
  all: boolean;
}

/**
 * 並べ替えの指定。
 *
 * ファイルの中身は動かさず、見せる順だけを変える
 */
export interface CsvSort {
  col: number;
  /** 大きい順に並べるか */
  desc: boolean;
}

/** 値の一覧の1つ */
export interface CsvFilterValue {
  text: string;
  /** その値の行数 */
  count: number;
}

/** 列に入っている値の一覧 */
export interface CsvFilterValues {
  values: CsvFilterValue[];
  /** 多すぎて途中で打ち切ったか */
  truncated: boolean;
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

/** 1つだけ置き換えた結果 */
export interface CsvReplaceOne {
  /** 実際に置き換えたか (今いるセルが引っかからなければ false) */
  done: boolean;
  info: CsvInfo;
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
