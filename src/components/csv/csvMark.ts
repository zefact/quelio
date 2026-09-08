/**
 * 表のセルの中で、探している語に当たる所を切り分ける。
 *
 * 画面に描くのは `CsvGrid` の役目なので、
 * ここでは「どこが当たったか」だけを返す (数え方だけを試せるように)
 */

/** 切り分けた1つぶん */
export interface MarkSegment {
  text: string;
  /** 探している語に当たった所か */
  hit: boolean;
}

/**
 * 文字を、探している語のところで切り分ける。
 *
 * 語が空のときや当たらないときは、丸ごと1つだけ返す
 * (呼ぶ側で「当たりが無い」を場合分けしなくてよいように)
 */
export function markSegments(
  text: string,
  query: string,
  matchCase: boolean
): MarkSegment[] {
  if (!query || !text) return [{ text, hit: false }];
  const hay = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? query : query.toLowerCase();

  const out: MarkSegment[] = [];
  let at = 0;
  for (;;) {
    const found = hay.indexOf(needle, at);
    if (found === -1) break;
    if (found > at) out.push({ text: text.slice(at, found), hit: false });
    out.push({ text: text.slice(found, found + needle.length), hit: true });
    at = found + needle.length;
  }
  if (out.length === 0) return [{ text, hit: false }];
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
