/**
 * ツールチップを置く位置を決める (TooltipLayer が使う)。
 *
 * 決まりは CSS で描いていたころと同じ:
 *  - 対象の下に 8px 空けて出す。下に入らなければ上に出す
 *  - 既定は対象の右端にそろえて左へ伸ばす。tooltip-left なら左端にそろえて右へ伸ばす
 *  - どちらの場合も、画面の端から 8px より外へは出さない
 */

/** 対象とツールチップのあいだ */
export const TIP_GAP = 8;
/** 画面の端から空ける余白 */
export const TIP_MARGIN = 8;

export interface TipRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface TipSize {
  width: number;
  height: number;
}

/** 対象のどちらの端にそろえるか */
export type TipAlign = "left" | "right";

export function placeTooltip(
  anchor: TipRect,
  tip: TipSize,
  view: TipSize,
  align: TipAlign,
): { left: number; top: number } {
  // 縦: 下に入るなら下、入らず上に入るなら上、どちらも無理なら広いほう
  const below = anchor.bottom + TIP_GAP;
  const above = anchor.top - TIP_GAP - tip.height;
  const fitsBelow = below + tip.height <= view.height - TIP_MARGIN;
  const fitsAbove = above >= TIP_MARGIN;
  let top: number;
  if (fitsBelow || !fitsAbove) {
    top =
      fitsBelow || view.height - anchor.bottom >= anchor.top ? below : above;
  } else {
    top = above;
  }
  top = clamp(top, TIP_MARGIN, view.height - TIP_MARGIN - tip.height);

  // 横: そろえる端を決めてから、画面の中へ押し戻す
  const left = align === "left" ? anchor.left : anchor.right - tip.width;
  return {
    left: clamp(left, TIP_MARGIN, view.width - TIP_MARGIN - tip.width),
    top,
  };
}

/** min..max に収める (max が min より小さいとき、つまり画面より大きいときは min) */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(v, max));
}
