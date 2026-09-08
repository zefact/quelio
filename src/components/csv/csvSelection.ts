/**
 * CSVエディタで選んでいる範囲の扱い。
 *
 * 選択は「四角の並び」で持つ。
 * ふつうは1つだけだが、⌘+クリックで離れた所も足せるので複数になる。
 *
 * 画面の描き方とは切り離してあるので、数え方だけを試せる
 */

/** セルの位置 */
export interface CsvCursor {
  row: number;
  col: number;
}

/** 選んでいる四角 (端を含む) */
export interface CsvRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** 起点と端から四角を作る (どちらが先でも同じ結果になる) */
export function normalize(a: CsvCursor, b: CsvCursor): CsvRange {
  return {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.col, b.col),
    right: Math.max(a.col, b.col),
  };
}

/** そのセルが四角の中にあるか */
export function inRange(r: CsvRange, row: number, col: number): boolean {
  return row >= r.top && row <= r.bottom && col >= r.left && col <= r.right;
}

/** どれかの四角に入っているか */
export function inAny(rs: CsvRange[], row: number, col: number): boolean {
  return rs.some((r) => inRange(r, row, col));
}

/**
 * 選んでいるセルの数。
 *
 * 重なった所は二重に数える (表計算ソフトの合計と数え方を揃えるため)
 */
export function selectionCells(rs: CsvRange[]): number {
  return rs.reduce(
    (n, r) => n + (r.bottom - r.top + 1) * (r.right - r.left + 1),
    0
  );
}

/** 四角を画面に置くときの位置と大きさ (選んだ範囲を枠で囲むのに使う) */
export interface FrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 四角を囲む枠の位置を出す。
 *
 * 列の幅は列ごとに違うので、左端の位置と幅を足し上げて求める
 */
export function frameBox(
  r: CsvRange,
  lefts: number[],
  widths: number[],
  rowHeight: number,
  numWidth: number
): FrameBox {
  let width = 0;
  for (let c = r.left; c <= r.right; c++) width += widths[c] ?? 0;
  return {
    left: lefts[r.left] ?? numWidth,
    top: r.top * rowHeight,
    width,
    height: (r.bottom - r.top + 1) * rowHeight,
  };
}

/**
 * 外からカーソルを動かされたとき、選んでいた範囲をどうするか。
 *
 * 何もしないと、伸ばしていた先 (`head`) だけが取り残されて、
 * 動く前の所と動いた先の間が選ばれた妙な四角になってしまう。
 *
 * @param keep 範囲を残すか (「選んだ範囲の中だけを探す」の最中は残す)
 * @param from 動く前にカーソルがあった所
 * @param head 範囲を伸ばしていた先 (伸ばしていなければ null)
 * @returns `"clear"` なら範囲を消す。四角を返したらそれを固定して残す。
 *   `null` なら足すものは無い (残っている範囲はそのまま)
 */
export function jumpFix(
  keep: boolean,
  from: CsvCursor | null,
  head: CsvCursor | null
): "clear" | { a: CsvCursor; b: CsvCursor } | null {
  if (!keep) return "clear";
  if (!from || !head) return null;
  // 伸ばしていない (1セルだけ) なら、足しても意味が無い
  if (head.row === from.row && head.col === from.col) return null;
  return { a: from, b: head };
}
