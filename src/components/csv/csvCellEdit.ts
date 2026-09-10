/**
 * セルの入力欄での、文字の入れ方の計算。
 *
 * 画面の描き方とは切り離してあるので、入れる位置だけを試せる
 */

/** 文字を入れたあとの中身と、印の位置 */
export interface Inserted {
  text: string;
  /** 入れたあとに印を置く位置 */
  caret: number;
}

/**
 * 選んでいるところを差し替えて、改行を入れる (Option/Alt + Enter)。
 *
 * 端をはみ出す指定や、始めと終わりが逆の指定でも壊れないようにそろえる
 */
export function insertNewline(
  text: string,
  start: number,
  end: number
): Inserted {
  const a = clamp(Math.min(start, end), text.length);
  const b = clamp(Math.max(start, end), text.length);
  return {
    text: `${text.slice(0, a)}\n${text.slice(b)}`,
    caret: a + 1,
  };
}

/** 0 と文字数のあいだに収める */
function clamp(v: number, max: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(v, max);
}

/** 改行で切り分ける (CR / LF / CRLF のどれでも1つの改行として扱う) */
export function lineParts(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** 中身の行数 (入力欄の高さを決めるのに使う) */
export function lineCount(text: string): number {
  return lineParts(text).length;
}
