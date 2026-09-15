/**
 * 比較画面で列の幅を変えるときの計算。
 *
 * 比較では左右に同じ列を並べるので、幅は左右で共通。
 * 画面とは関係のない数の話なのでここに分けてある
 * (真ん中の仕切りは左右の取り分を変えるだけで、幅には触らない)
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
