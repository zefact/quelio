/**
 * 結果バー (データタブ・SQL結果) に出す件数と時間の文言。
 *
 * 2つの画面で言い方がずれないよう、ここで1か所にまとめて作る
 */
import { QUERY_PAGE_SIZE } from "./types";

/** 結果バーに出す件数の種類 */
export type ResultRange =
  /** ページごとに取っている表 (何行目から何行目か) */
  | { kind: "page"; offset: number; rows: number }
  /** ページ送りできない表 (先頭だけ取ったかどうか) */
  | { kind: "head"; rows: number; more: boolean }
  /** 表にならない文 (UPDATE など。影響した行数) */
  | { kind: "exec"; affected: number };

/** 件数の部分 (例: 「1〜1,000行目」「0行」「3行に影響」) */
export function rangeText(range: ResultRange): string {
  switch (range.kind) {
    case "page":
      return range.rows === 0
        ? "0行"
        : `${(range.offset + 1).toLocaleString()}〜${(
            range.offset + range.rows
          ).toLocaleString()}行目`;
    case "head":
      return `${range.rows.toLocaleString()}行${range.more ? " (先頭のみ表示)" : ""}`;
    case "exec":
      return `${range.affected.toLocaleString()}行に影響`;
  }
}

/** 取得した時刻 (時:分:秒) */
export function clockOf(ms: number): string {
  const d = new Date(ms);
  const p2 = (v: number) => String(v).padStart(2, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/**
 * 件数・かかった時間・いつの内容か を1行にしたもの。
 * fetchedAt は取り直さずに出していることがある画面 (データタブ) だけが渡す
 */
export function resultMetaText(
  range: ResultRange,
  elapsedMs: number,
  fetchedAt?: number
): string {
  return (
    `${rangeText(range)} — ${elapsedMs}ms` +
    (fetchedAt !== undefined ? ` — ${clockOf(fetchedAt)} 時点` : "")
  );
}

/** ページ送りボタンの説明 (前へ / 次へ) */
export function pagerLabel(dir: "prev" | "next"): string {
  return `${dir === "prev" ? "前" : "次"}の${QUERY_PAGE_SIZE.toLocaleString()}行`;
}

/** ページ送りを出すか (2ページ目以降にいるか、続きがあるときだけ) */
export function showPager(offset: number, hasMore: boolean): boolean {
  return offset > 0 || hasMore;
}
