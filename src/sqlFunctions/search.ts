/**
 * 関数リファレンスの絞り込み。
 *
 * 名前だけで引けると「何という名前だったか」を思い出せないので、
 * 説明・補足・関連語も見る (「切り捨て」「前ゼロ」「月末」で引ける)
 */
import type { SqlFunc, SqlFuncGroup } from "./types";

/** 絞り込みの結果1件 (どの分類のものかを添える) */
export interface SqlFuncHit {
  category: string;
  func: SqlFunc;
}

/** 分類の並びを、1件ずつの並びに開く */
export function flatten(groups: SqlFuncGroup[]): SqlFuncHit[] {
  return groups.flatMap((g) =>
    g.items.map((func) => ({ category: g.category, func }))
  );
}

/** 引っかけるための文字列 (名前・書式・説明・補足・関連語) */
function haystack(hit: SqlFuncHit): string {
  const f = hit.func;
  return [
    f.name,
    f.signature,
    f.summary,
    f.note ?? "",
    hit.category,
    ...(f.keywords ?? []),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * 絞り込む。
 *
 * 空白で区切った語は、すべて含むものだけを返す (AND)。
 * 名前の先頭に当たったものを上に持ってくる
 */
export function searchFunctions(
  groups: SqlFuncGroup[],
  query: string
): SqlFuncHit[] {
  const all = flatten(groups);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return all;
  const hits = all.filter((h) => {
    const text = haystack(h);
    return words.every((w) => text.includes(w));
  });
  const head = words[0];
  return hits.sort((a, b) => rank(a, head) - rank(b, head));
}

/** 並べ替えの重み (小さいほど上) */
function rank(hit: SqlFuncHit, word: string): number {
  const name = hit.func.name.toLowerCase();
  if (name === word) return 0;
  if (name.startsWith(word)) return 1;
  if (name.includes(word)) return 2;
  return 3;
}
