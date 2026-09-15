/**
 * 履歴・お気に入りの絞り込み。
 *
 * 画面とは関係のない文字の話なので、ここに分けて試せるようにしてある。
 * 探し方は「空白で区切った語をすべて含むもの」(大文字小文字は区別しない)
 */
import type { SavedSqlEntry, SavedSqlStore, SqlHistoryEntry } from "./types";

/** 検索欄の文字を、探す語の並びにする (空白区切り) */
export function searchTerms(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== "");
}

/** その文字列が、探す語をすべて含むか */
export function matchesTerms(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const lower = text.toLowerCase();
  return terms.every((t) => lower.includes(t));
}

/** 履歴を絞り込む (SQLの中身で探す) */
export function filterHistory(
  entries: SqlHistoryEntry[],
  query: string,
): SqlHistoryEntry[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return entries;
  return entries.filter((h) => matchesTerms(h.sql, terms));
}

/**
 * お気に入りを絞り込む (名前・フォルダ・SQLの中身で探す)。
 *
 * 絞り込み中はフォルダの階層をたどらず、
 * 見つかったものだけを保存順のまま平らに並べる
 */
export function filterSaved(
  store: SavedSqlStore,
  query: string,
): SavedSqlEntry[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const hit = (e: SavedSqlEntry) =>
    matchesTerms(e.name, terms) ||
    matchesTerms(e.folder, terms) ||
    matchesTerms(e.sql, terms);
  // 保存されている表示順 ("i:<ID>") のまま並べる
  const byId = new Map(store.items.map((e) => [e.id, e]));
  const out: SavedSqlEntry[] = [];
  for (const key of store.order) {
    if (!key.startsWith("i:")) continue;
    const e = byId.get(key.slice(2));
    if (e && hit(e)) {
      out.push(e);
      byId.delete(e.id);
    }
  }
  // 並びに入っていないもの (古い保存先を読んだときなど) は後ろへ
  for (const e of store.items) {
    if (byId.has(e.id) && hit(e)) out.push(e);
  }
  return out;
}

/** 1行プレビューに載せる長さ */
const PREVIEW_LEN = 80;

/** 見つかった語の前に残す長さ (前後の文脈が少し見えるように) */
const LEAD = 20;

/**
 * 一覧に出す1行プレビュー。
 *
 * 探している語が先頭から遠いところにあると、
 * 頭から80文字だけでは「なぜ引っかかったのか」が見えない。
 * その場合は、見つかった所の少し手前から切り出す
 */
export function previewLine(sql: string, query: string): string {
  const line = sql.replace(/\s+/g, " ").trim();
  const terms = searchTerms(query);
  let from = 0;
  if (terms.length > 0) {
    const lower = line.toLowerCase();
    // いちばん手前で見つかった語に合わせる
    const found = terms
      .map((t) => lower.indexOf(t))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    // 頭から80文字の中に入っていれば、そのまま頭から出せばよい
    if (found !== undefined && found >= PREVIEW_LEN) {
      from = found - LEAD;
    }
  }
  const head = from > 0 ? "…" : "";
  const body = line.slice(from, from + PREVIEW_LEN);
  const tail = from + PREVIEW_LEN < line.length ? "…" : "";
  return head + body + tail;
}
