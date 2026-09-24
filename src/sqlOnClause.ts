/**
 * JOIN の ON を次の行へ出し、条件を一段下げる。
 *
 * 例:
 *   INNER JOIN m_shop b ON a.user_id = b.user_id
 * →
 *   INNER JOIN m_shop b
 *   ON
 *     a.user_id = b.user_id
 *
 * 続く AND / OR の行も同じ結合条件なので、まとめて一段下げる
 * (元の行の空白はそのまま残すので、幅をそろえる字下げでも列が崩れない)
 */

/** `… JOIN b ON 条件` (JOINと同じ行にONがある形) */
const JOIN_ON = /^(\s*)(.*\bJOIN\b.*?)\s+\b(ON)\b\s+(.+)$/i;

/**
 * `) tod ON 条件` (副問い合わせを閉じた行にONが続く形)。
 *
 * JOINの相手が副問い合わせのときは、整形器が
 * 「INNER JOIN (」…「) tod ON …」と分けて出すので、
 * ONのある行にJOINが無い。JOINだけを見ていると、
 * この結合だけONが同じ行に残ってしまう
 */
const DERIVED_ON = /^(\s*)(\)\s*(?:AS\s+)?[\w.`"[\]]*)\s+\b(ON)\b\s+(.+)$/i;

/** 続く結合条件の行 (AND / OR) */
const COND_CONT = /^(\s*)(AND|OR)\b/i;

export function toOnNewline(sql: string, unit: string): string {
  const src = sql.split("\n");
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const m = JOIN_ON.exec(src[i]) ?? DERIVED_ON.exec(src[i]);
    if (!m) {
      out.push(src[i]);
      continue;
    }
    const [, indent, head, on, cond] = m;
    out.push(indent + head, indent + on, indent + unit + cond);
    // 同じ深さで続く AND / OR は、この ON の条件の続き
    while (i + 1 < src.length) {
      const next = COND_CONT.exec(src[i + 1]);
      if (!next || next[1] !== indent) break;
      out.push(unit + src[i + 1]);
      i++;
    }
  }
  return out.join("\n");
}
