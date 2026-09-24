/**
 * カンマ先頭スタイルへの並べ替え。
 *
 * 整形器 (sql-formatter) は行末にカンマを置く形しか作れないので、
 * 整形したあとの文字列を行単位で組み替えている。
 * コメントが混じると難しくなるので、その扱いをここにまとめた
 */

/** ブロックコメントが閉じた後ろに残る中身 (閉じていなければ null) */
function afterBlockEnd(trimmed: string): string | null {
  const i = trimmed.lastIndexOf("*/");
  return i < 0 ? null : trimmed.slice(i + 2).trim();
}

/**
 * コメントだけの行に印を付ける。
 *
 * カンマの移し先にできない行を見分けるために使う。
 * コメント行の先頭にカンマを付けると、カンマごとコメントに飲まれて
 * SQLが壊れる (`-- , x` の前に付けても効かない)
 */
export function commentOnlyLines(lines: string[]): boolean[] {
  let inBlock = false;
  return lines.map((line) => {
    const t = line.trim();
    if (inBlock) {
      const rest = afterBlockEnd(t);
      if (rest === null) return true;
      inBlock = false;
      // 閉じたあとに中身が続く行は、SQL本体のある行として扱う
      return rest === "";
    }
    if (t.startsWith("/*")) {
      const rest = afterBlockEnd(t);
      if (rest === null) {
        inBlock = true;
        return true;
      }
      return rest === "";
    }
    return t.startsWith("--") || t.startsWith("#");
  });
}

/**
 * 行末のカンマを次行の先頭に移す (カンマ先頭スタイル)。
 * 例: "  company_cd,"  →  "  company_cd" / "  , company_kbn"
 *
 * 移し先は「次のSQL本体がある行」。空行とコメント行は飛ばす。
 * また、整形器はコメントに挟まれたカンマを単独の行に出すことがあるので
 * (コメント行の次が「,」だけの行になる)、カンマを外して何も残らない行は
 * 空行として残さずに消す
 */
export function toLeadingCommas(sql: string): string {
  const lines = sql.split("\n");
  const comment = commentOnlyLines(lines);
  /** カンマを外して何も残らなくなった行 (消す対象) */
  const dropped = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    // コメント行の中のカンマは動かさない (文の区切りではない)
    if (comment[i]) continue;
    if (!lines[i].trimEnd().endsWith(",")) continue;
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === "" || comment[j])) j++;
    if (j >= lines.length) continue;
    lines[i] = lines[i].trimEnd().slice(0, -1);
    lines[j] = lines[j].replace(/^(\s*)/, "$1, ");
    if (lines[i].trim() === "") dropped.add(i);
  }
  return lines.filter((_, i) => !dropped.has(i)).join("\n");
}
