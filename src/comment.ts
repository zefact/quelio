/** コメントの「論理名＋補足」分解 (区切り文字は設定で変更可) */

/** 開き括弧に対応する閉じ括弧 */
export const CLOSING: Record<string, string> = {
  "（": "）",
  "(": ")",
  "【": "】",
  "[": "]",
  "「": "」",
  "{": "}",
  "<": ">",
};

/** コメントを [論理名, 補足] に分解する。区切りが空なら分解しない */
export function parseComment(c: string, delim: string): [string, string] {
  if (!delim) return [c, ""];
  const idx = c.indexOf(delim);
  if (idx < 0) return [c, ""];
  let note = c.slice(idx + delim.length);
  const close = CLOSING[delim];
  if (close && note.endsWith(close)) note = note.slice(0, -close.length);
  return [c.slice(0, idx).trim(), note.trim()];
}
