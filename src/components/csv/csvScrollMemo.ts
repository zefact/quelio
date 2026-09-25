/**
 * CSVの表のスクロール位置の控え。
 *
 * タブを切り替えると表は作り直されるので、そのままでは先頭へ戻ってしまう。
 * 表 (左右どちらの面の、どのファイルか) ごとに控えておき、作り直したときに戻す
 */

export interface CsvScrollPos {
  top: number;
  left: number;
}

/** 覚えておく表の数 (古いものから捨てる) */
export const CSV_SCROLL_LIMIT = 100;

/** 挿入順 = 使った順 */
const memo = new Map<string, CsvScrollPos>();

/** 控えを書く */
export function saveCsvScroll(key: string, pos: CsvScrollPos): void {
  memo.delete(key);
  memo.set(key, pos);
  while (memo.size > CSV_SCROLL_LIMIT) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

/** 控えを読む */
export function loadCsvScroll(key: string): CsvScrollPos | undefined {
  return memo.get(key);
}
