/**
 * SQLの中で「カーソルがどの文にいるか」を出す。
 *
 * 文の区切り方はサーバーの設定で変わるので、分けるのはバックエンドに任せ
 * (split_sql_statements)、ここは返ってきた文がテキストのどこにあるかを探すだけ。
 * 位置ではなく文の並びを受け取るのは、Rustのバイト位置と
 * 画面の文字位置がずれる (日本語やコメントを含むと合わない) ため
 */

/** 文のある範囲 (エディタの文字位置) */
export interface SqlSpan {
  text: string;
  from: number;
  to: number;
}

/**
 * 分割された文が、元のSQLのどこにあるかを探す。
 *
 * 文は元の並びどおりに返ってくるので、前の文の続きから探せばよい
 * (同じ文が何度も出てきても取り違えない)
 */
export function spansOf(sql: string, statements: string[]): SqlSpan[] {
    const out: SqlSpan[] = [];
  let at = 0;
  for (const text of statements) {
    if (!text) continue;
    const from = sql.indexOf(text, at);
    // 見つからないのは分割と手元のテキストがずれたとき (何もしない)
    if (from < 0) continue;
    out.push({ text, from, to: from + text.length });
    at = from + text.length;
  }
  return out;
}

/**
 * カーソル位置にある文を返す。
 *
 * 文と文の間 (空行やコメント) にいるときは、直前の文を選ぶ。
 * 「今書き終えた文を流す」のが普通の使い方なので、後ろではなく前を採る
 */
export function spanAt(spans: SqlSpan[], cursor: number): SqlSpan | null {
  if (spans.length === 0) return null;
  // 文の中 (末尾に触れている場合も含む)
  const inside = spans.find((s) => cursor >= s.from && cursor <= s.to);
  if (inside) return inside;
  // 手前にある文のうち、いちばん後ろのもの
  const before = spans.filter((s) => s.to < cursor);
  if (before.length > 0) return before[before.length - 1];
  // 先頭より前にいるときは最初の文
  return spans[0];
}
