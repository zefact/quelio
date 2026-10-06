/**
 * 一覧 (左のテーブル一覧など) のスクロール位置の控え。
 *
 * 接続タブを切り替えても画面の部品は使い回されるので、そのままだと
 * 片方の一覧をスクロールした位置が、もう片方にも付いてきてしまう。
 * 一覧ごと (接続タブ・DBごと) に位置を控え、切り替えたらその一覧の位置へ戻す
 */

/** 覚えておく一覧の数 (古いものから捨てる) */
export const LIST_SCROLL_LIMIT = 200;

/** 挿入順 = 使った順 */
const memo = new Map<string, number>();

/** 控えを書く */
export function saveListScroll(key: string, top: number): void {
  memo.delete(key);
  memo.set(key, top);
  while (memo.size > LIST_SCROLL_LIMIT) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

/** 控えを読む (無ければ先頭) */
export function loadListScroll(key: string): number {
  return memo.get(key) ?? 0;
}
