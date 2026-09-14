/**
 * 比較画面で列の幅を変えるときの計算。
 *
 * 比較では左右に同じ列を並べるので、幅は左右で共通。
 * 「つまみを引く」のと「真ん中の仕切りを動かす」の2通りがあり、
 * どちらも画面とは関係のない数の話なのでここに分けてある
 */
import { MAX_W, MIN_W } from "./csvWidth";

/** 下限・上限で丸める */
function clamp(w: number): number {
  return Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
}

/**
 * つまみを引いたときの、その列の幅。
 *
 * 掴んだときの幅に、動かしたぶんを足すだけ
 */
export function dragWidth(startWidth: number, dx: number): number {
  return clamp(startWidth + dx);
}

/**
 * 真ん中の仕切りを動かしたときの、それぞれの列の幅。
 *
 * 左右は同じ列を並べているので、片側だけを広げることはできない。
 * 代わりに、掴んだときの幅をまとめて伸び縮みさせる
 * (列どうしの幅の比は保たれる)。
 *
 * どの列にも下限と上限があるので、全部が端に当たると仕切りは止まる
 *
 * @param startWidths 掴んだときの、それぞれの列の幅
 * @param dx 掴んだ所からの移動量 (px。右が+)
 */
export function splitWidths(startWidths: number[], dx: number): number[] {
  const span = startWidths.reduce((a, b) => a + b, 0);
  if (span <= 0) return startWidths;
  // 仕切りを動かしたぶんだけ、列の合計を伸び縮みさせる
  const factor = Math.max(0, span + dx) / span;
  return startWidths.map((w) => clamp(w * factor));
}
