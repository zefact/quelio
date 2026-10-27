/**
 * 表を作り直さずに列が変わったとき、それまでの列幅を引き継ぐ。
 *
 * セルを書き換えるたびに列名の一覧は新しく届くが、中身は同じことが多い。
 * そのたびに幅を測り直すと、行を読み直している最中で中身が見えず
 * 見出しだけの狭い幅になり、右へスクロールしていた位置が左へ戻されてしまう
 * (手で変えた幅も元に戻ってしまう)
 */

/** 列を足した・消したときの手がかり (どこに何本か) */
export interface CsvColShift {
  /** 操作のあとの列名 (この一覧が届いたときだけ使う) */
  columns: string[];
  /** 足した・消した位置 */
  at: number;
  /** 足した本数 (消したときはマイナス) */
  delta: number;
}

/**
 * 前の列幅から、新しい列の並びの幅を作る。
 *
 * - 列を足した・消した手がかりがあれば、その位置で幅をずらす
 * - 列の数が同じなら幅はそのまま (名前が変わった列は、名前が収まるまで広げる)
 * - それ以外 (取り消しで列数が変わった、読み直したなど) は引き継げないので null
 *
 * `fit` は列名だけから見た幅 (足した列や名前が変わった列に使う)
 */
export function carryWidths(
  prevCols: string[],
  prevWidths: number[],
  nextCols: string[],
  fit: (name: string) => number,
  shift?: CsvColShift
): number[] | null {
  if (prevWidths.length !== prevCols.length) return null;
  if (shift && nextCols.length === prevCols.length + shift.delta) {
    const { at, delta } = shift;
    if (at < 0 || at > prevWidths.length) return null;
    if (delta >= 0) {
      const added = nextCols.slice(at, at + delta).map(fit);
      return [
        ...prevWidths.slice(0, at),
        ...added,
        ...prevWidths.slice(at),
      ];
    }
    if (at - delta > prevWidths.length) return null;
    return [...prevWidths.slice(0, at), ...prevWidths.slice(at - delta)];
  }
  if (nextCols.length !== prevCols.length) return null;
  return prevWidths.map((w, i) =>
    nextCols[i] === prevCols[i] ? w : Math.max(w, fit(nextCols[i]))
  );
}
