/**
 * 要素に今かかっている縦方向の移動量 (transform の translateY) をpxで返す。
 *
 * 行の並べ替えアニメーション中は、要素の「レイアウト上の位置」と
 * 「実際に見えている位置」がずれる。
 * その差を打ち消すために使う (アニメーションの継ぎ足しや当たり判定)
 */
export function translateY(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return 0;
  try {
    return new DOMMatrixReadOnly(t).m42;
  } catch {
    return 0;
  }
}
