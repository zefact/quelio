/**
 * 表の列の幅を決めるものさし。
 *
 * 実際に描いた文字を測るのではなく、文字の数から見当を付ける。
 * 何万行もある表で1列ずつ本当に測ると、そのたびに画面が止まってしまうため。
 * 見出しと中身の両方が収まる幅を返す
 */

/** 列の幅の下限・上限 */
export const MIN_W = 60;
export const MAX_W = 480;

/** 見出し1文字ぶんの見当 (太字なので中身より少し広く見る) */
const HEAD_PER_CHAR = 8;
/** 見出しの左右の余白 */
const HEAD_PAD = 28;
/** 中身1文字ぶんの見当 */
const CELL_PER_CHAR = 7.5;
/** 中身の左右の余白 */
const CELL_PAD = 24;

/**
 * 文字のだいたいの幅 (半角を1、全角を2として数える)。
 *
 * 漢字・かな・全角記号は半角の倍の幅で描かれるので、2つぶんとして数える
 */
export function textWidth(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    n += c > 0x1100 && c < 0xfb00 ? 2 : 1;
  }
  return n;
}

/**
 * 見出しと中身が収まる列の幅。
 *
 * 下限と上限で丸めるので、空の列でも潰れず、長すぎる値でも広がりすぎない
 */
export function fitWidth(name: string, values: Iterable<string>): number {
  let w = textWidth(name) * HEAD_PER_CHAR + HEAD_PAD;
  for (const v of values) {
    w = Math.max(w, textWidth(v) * CELL_PER_CHAR + CELL_PAD);
  }
  return Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
}
