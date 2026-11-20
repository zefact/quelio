/**
 * 設定画面の「復元」で、取り込む前の確認に出す文言を作る。
 *
 * 件数と名前はバックエンドが書き込まずに数えたもの (RestorePreview)
 */

/** 上書きされるものの名前を、いくつまで並べるか */
export const NAME_LIMIT = 5;

/** 件数の1行 (例: 追加2件 / 上書き1件)。完了の通知と同じ書き方にする */
export function restoreCounts(p: { added: number; updated: number }): string {
  return `追加${p.added}件 / 上書き${p.updated}件`;
}

/**
 * 上書きされるものの名前を並べる (例: 「受注」「在庫」ほか3件)。
 *
 * 多いときは先頭の `limit` 件だけを出し、残りは数で書く。
 * 残りが1件だけなら、「ほか1件」と書くより名前を出したほうが早いので全部出す
 */
export function overwrittenNames(
  names: string[],
  limit: number = NAME_LIMIT
): string {
  const quote = (n: string) => `「${n === "" ? "(名前なし)" : n}」`;
  if (names.length <= limit + 1) return names.map(quote).join("");
  const rest = names.length - limit;
  return `${names.slice(0, limit).map(quote).join("")} ほか${rest}件`;
}

/** ファイルの場所から、見出しに出すファイル名だけを取り出す */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
