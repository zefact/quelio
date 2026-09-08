/**
 * スクロールバーのぶんだけ端に空けておく余白を決める。
 *
 * スクロールバーには2種類ある。
 * ひとつは中身の上へ重なって出るもの (macOSの既定) で、こちらは場所を取らない。
 * もうひとつは場所を取るもので、このアプリのように `::-webkit-scrollbar` で
 * 見た目を整えると、WebKitはこちらになる。
 *
 * 重なって出るときは、端に寄せた行や列がバーの下に隠れてしまうので、
 * その厚みぶんを先に空けておく必要がある。
 * 逆に場所を取るときに余白を空けると、最終行と下の情報バーの間が
 * 開いたままになってしまうので、余白は要らない。
 * どちらであるかは環境で決まるので、実際に測って決める
 */

/**
 * 重なって出るバーの厚み。
 *
 * 場所を取らないぶん測りようがないので、macOSの見た目に合わせた値を使う
 */
export const OVERLAY_BAR = 16;

/**
 * ヘッダ・トレーラの表で使う細いバーの厚み。
 *
 * `csv.css` の `.csv-edge-grid .csv-grid::-webkit-scrollbar` と合わせてある
 */
export const THIN_BAR = 8;

/**
 * 測った厚みから、表の端に空けておく余白を出す。
 *
 * @param thickness 場所を取るバーの厚み (0なら重なって出る作り)
 * @param bar その表に出るバーの厚み
 */
export function gapFor(thickness: number, bar = 0): number {
  return thickness > 0 ? bar : OVERLAY_BAR;
}

/** 測った結果。何度も測らずに済むよう覚えておく */
let known: number | null = null;

/**
 * 場所を取るスクロールバーの厚み。0なら中身の上へ重なって出る作り。
 *
 * 中が見えないくらい小さい箱を置いて、外側と内側の高さの差を見る
 */
export function barThickness(): number {
  if (known !== null) return known;
  if (typeof document === "undefined" || !document.body) return 0;
  const box = document.createElement("div");
  box.style.cssText =
    "position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll;";
  document.body.appendChild(box);
  known = box.offsetHeight - box.clientHeight;
  box.remove();
  return known;
}

/**
 * データ行の表の端に空けておく余白。
 *
 * 場所を取るバーなら、バー自身が下と右に居場所を持つので余白は要らない
 */
export function edgeGap(): number {
  return gapFor(barThickness());
}

/** ヘッダ・トレーラの表の下に空けておく余白 (細いバーが入るぶん) */
export function thinGap(): number {
  return gapFor(barThickness(), THIN_BAR);
}
