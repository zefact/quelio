/**
 * タブをドラッグしている最中の「どこへ落ちるか」と「誰がどれだけ動くか」。
 *
 * 掴んだタブは指についてきて、まわりのタブは場所を空けるように横へ滑る。
 * 画面もReactも出てこない計算だけなので、ここに分けて試せるようにしている
 */

/** 並んでいるタブ1つぶんの位置 (掴む前に測ったもの) */
export interface TabRect {
  /** 左端 (px) */
  left: number;
  /** 幅 (px) */
  width: number;
}

/** タブの中心 */
function centerOf(r: TabRect): number {
  return r.left + r.width / 2;
}

/**
 * タブとタブの間隔 (px)。
 *
 * 掴んだタブが抜けた・入ったときに、まわりがどれだけずれるかは
 * 「掴んだタブの幅 + 間隔」ちょうどになる
 */
export function gapOf(rects: TabRect[]): number {
  if (rects.length < 2) return 0;
  return Math.max(0, rects[1].left - (rects[0].left + rects[0].width));
}

/**
 * まわりのタブが動く量 (px)。掴んだタブが占めていた場所ぶん
 */
export function slideWidth(rects: TabRect[], from: number): number {
  const r = rects[from];
  return r ? r.width + gapOf(rects) : 0;
}

/**
 * 今どこへ落ちるか。
 *
 * 隣のタブの真ん中を越えたら入れ替わる。
 * 端をまたいだ瞬間ではなく真ん中を基準にするので、
 * 境目で行ったり来たりしない
 */
export function dropIndex(rects: TabRect[], from: number, dx: number): number {
  const me = rects[from];
  if (!me) return from;
  const left = me.left + dx;
  const right = left + me.width;

  let to = from;
  // 右へ: 右端が、次のタブの真ん中を越えたら1つ進む
  while (to + 1 < rects.length && right > centerOf(rects[to + 1])) to++;
  // 左へ: 左端が、前のタブの真ん中を越えたら1つ戻る
  while (to - 1 >= 0 && left < centerOf(rects[to - 1])) to--;
  return to;
}

/**
 * タブ i を、今どれだけ横へずらして描くか (px)。
 *
 * 掴んでいるタブは指の動きぶん、
 * 掴んだ場所と落とす場所の間にいるタブは、場所を空けるぶんだけ動く。
 * それ以外は動かない
 */
export function slideOf(
  rects: TabRect[],
  from: number,
  to: number,
  dx: number,
  index: number
): number {
  if (index === from) return dx;
  const w = slideWidth(rects, from);
  // 右へ運ぶとき、間にいるタブは左へ詰める
  if (from < to && index > from && index <= to) return -w;
  // 左へ運ぶとき、間にいるタブは右へ寄る
  if (to < from && index >= to && index < from) return w;
  return 0;
}
