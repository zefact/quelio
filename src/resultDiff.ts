/**
 * 2つの実行結果を見比べるための差分。
 *
 * 「直したあとに件数が変わっていないか」「どの行が増減したか」を
 * 目で追えるようにする。行の並び順は当てにせず、中身が同じ行どうしを突き合わせる
 * (同じ内容の行が複数あっても、数が合っているぶんは差分にしない)
 */

/** 値の区切り (データに出てこない制御文字を使う) */
const SEP = "\u001f";

/**
 * 行の中身から作る照合キー。
 *
 * NULLと空文字、区切りを含む値と分かれた値を取り違えないよう、
 * 値の前に印を付けてから繋ぐ
 */
export function rowKey(cells: (string | null)[]): string {
  return cells.map((v) => (v === null ? "n" : `s${v}`)).join(SEP);
}

export interface ResultDiff {
  /** 列の並びが同じか (違うときは行の差分を出さない) */
  sameColumns: boolean;
  /** 左にしか無い行の位置 */
  onlyLeft: Set<number>;
  /** 右にしか無い行の位置 */
  onlyRight: Set<number>;
}

/** 片側にしか無い行を探す */
function missing(
  from: (string | null)[][],
  other: (string | null)[][]
): Set<number> {
  const rest = new Map<string, number>();
  for (const cells of other) {
    const k = rowKey(cells);
    rest.set(k, (rest.get(k) ?? 0) + 1);
  }
  const out = new Set<number>();
  from.forEach((cells, i) => {
    const k = rowKey(cells);
    const n = rest.get(k) ?? 0;
    if (n > 0) rest.set(k, n - 1);
    else out.add(i);
  });
  return out;
}

/** 2つの結果を突き合わせる */
export function diffResults(
  leftColumns: string[],
  leftRows: (string | null)[][],
  rightColumns: string[],
  rightRows: (string | null)[][]
): ResultDiff {
  const sameColumns =
    leftColumns.length === rightColumns.length &&
    leftColumns.every((c, i) => c === rightColumns[i]);
  if (!sameColumns) {
    return { sameColumns: false, onlyLeft: new Set(), onlyRight: new Set() };
  }
  return {
    sameColumns: true,
    onlyLeft: missing(leftRows, rightRows),
    onlyRight: missing(rightRows, leftRows),
  };
}
