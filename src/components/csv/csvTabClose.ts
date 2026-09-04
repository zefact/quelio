/**
 * CSVエディタのタブを「まとめて閉じる」ときの、閉じる相手の選び方。
 *
 * 画面の都合と切り離しておくと、並びの数え方だけを試せる
 */
import type { CsvInfo } from "../../types";

/** 閉じ方の種類 */
export type CloseKind = "self" | "others" | "right" | "all";

/** 閉じ方ごとの見出し (メニューと確認の両方で使う) */
export const CLOSE_LABEL: Record<CloseKind, string> = {
  self: "閉じる",
  others: "その他を閉じる",
  right: "右側をすべて閉じる",
  all: "すべて閉じる",
};

/**
 * `kind` で閉じることになるタブを、並び順のまま返す。
 *
 * `tab` が並びに無いときは何も返さない (閉じ終わった直後など)
 */
export function closeTargets(
  tabs: CsvInfo[],
  tab: CsvInfo,
  kind: CloseKind
): CsvInfo[] {
  const at = tabs.findIndex((t) => t.docId === tab.docId);
  if (at < 0) return [];
  switch (kind) {
    case "self":
      return [tabs[at]];
    case "others":
      return tabs.filter((_, i) => i !== at);
    case "right":
      return tabs.slice(at + 1);
    case "all":
      return [...tabs];
  }
}

/** 閉じると変更が消えるタブ (確認を出すかどうかの判断に使う) */
export function unsaved(targets: CsvInfo[]): CsvInfo[] {
  return targets.filter((t) => t.dirty);
}
