/**
 * 画面をまたいで使う独自イベント。
 * 深い階層のコンポーネントへ props を通さずに知らせたいものだけを置く
 */

/** ページ内検索を開く (⌘F と 検索ボタン) */
export const FIND_EVENT = "quelio-find";

/** SQLをお気に入りへ保存するダイアログを開く (⌘S) */
export const SAVE_SQL_EVENT = "quelio-save-sql";

/** イベントを送る */
export function emitAppEvent(name: string): void {
  window.dispatchEvent(new CustomEvent(name));
}
