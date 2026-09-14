/**
 * 並んだ値を IN 句の中身に整える。
 *
 * 表計算やメモから貼った
 *
 *   214234016
 *   214236030
 *
 * を
 *
 *   '214234016',
 *   '214236030'
 *
 * にする。区切りは改行のほかにカンマ・タブも認めるので、
 * 表計算から横に貼っても縦に貼っても同じ結果になる。
 */

/** 整え方 */
export interface InListOptions {
  /** ' ' で囲む (文字列の列に使うとき。数値の列ならfalse) */
  quote: boolean;
}

/** 区切り文字 (改行・カンマ・タブ。空白そのものは値に含めたい場合があるので外す) */
const SEPARATOR = /[\r\n,\t]+/;

/** 前後に付いている引用符を外す ('abc' → abc、"abc" → abc) */
function unquote(v: string): string {
  if (v.length >= 2) {
    const head = v[0];
    const tail = v[v.length - 1];
    if ((head === "'" && tail === "'") || (head === '"' && tail === '"')) {
      return v.slice(1, -1);
    }
  }
  return v;
}

/**
 * 貼り付けた文字を、値の並びに分ける。
 *
 * 前後の空白と、もともと付いていた引用符は外す。
 * 空の行は落とすが、同じ値が続いてもまとめない
 * (消すかどうかは書いた人が決めることなので、勝手に減らさない)
 */
export function splitValues(text: string): string[] {
  return text
    .split(SEPARATOR)
    .map((v) => unquote(v.trim()))
    .filter((v) => v !== "");
}

/**
 * 1つぶんを書き出す。
 *
 * 値の中の ' は '' にして閉じないようにする (SQLの決まり)
 */
function one(value: string, opts: InListOptions): string {
  return opts.quote ? `'${value.replace(/'/g, "''")}'` : value;
}

/** 行頭の空白 (字下げ) を取り出す */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/**
 * IN 句の中身に整えた文字列を返す。
 *
 * 1行に1つずつ並べ、最後の行にはカンマを付けない。
 * 元の字下げ (最初の行の行頭の空白) はそのまま引き継ぐ。
 * 値が1つも無いときは空文字を返す (呼ぶ側が「何もしない」と判断できる)
 */
export function toInList(text: string, opts: InListOptions): string {
  const values = splitValues(text);
  if (values.length === 0) return "";

  // 字下げは、値が入っている最初の行に合わせる
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const indent = indentOf(firstLine);

  return values
    .map((v, i) => indent + one(v, opts) + (i < values.length - 1 ? "," : ""))
    .join("\n");
}
