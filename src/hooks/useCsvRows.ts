import { useCallback, useEffect, useRef, useState } from "react";
import { csvPage } from "../api";

/**
 * 見えている範囲の行だけを取ってきて覚えておく。
 *
 * 全行はバックエンドが持っているので、画面はスクロールに合わせて
 * 必要なページだけを取りに行く。同じページを何度も取りに行かないよう、
 * 取れたものはここに溜めておく
 */

/** 1回に取りに行く行数 */
export const PAGE_ROWS = 500;

/** 見えている範囲の前後に、あらかじめ取っておくページ数 */
const AHEAD = 1;

export interface CsvRows {
  /** 行位置から値を引く (まだ取れていなければ null) */
  row: (index: number) => string[] | null;
  /** この範囲が見えていると伝える (足りないページを取りに行く) */
  ensure: (from: number, to: number) => void;
  /** 溜めたものを捨てる (編集したあとに使う) */
  clear: () => void;
  /** 取りに行って失敗した理由 */
  error: string | null;
  /** ページが届く (または捨てられる) たびに増える値。列幅の測り直しに使う */
  version: number;
}

export function useCsvRows(docId: string | null, rowCount: number): CsvRows {
  /*
   * ページはミュータブルな入れ物に貯める。
   * ここを state にすると1ページ届くたびに全行を作り直すことになり、
   * 大きなCSVでスクロールが引っかかる
   */
  const pages = useRef(new Map<number, string[][]>());
  const loading = useRef(new Set<number>());
  const [version, bump] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const clear = useCallback(() => {
    pages.current.clear();
    loading.current.clear();
    bump((n) => n + 1);
  }, []);

  // ファイルが変わったら、前のファイルのページを持ち越さない
  useEffect(() => {
    clear();
    setError(null);
  }, [docId, clear]);

  const load = useCallback(
    async (page: number) => {
      if (!docId) return;
      if (pages.current.has(page) || loading.current.has(page)) return;
      loading.current.add(page);
      try {
        const got = await csvPage(docId, page * PAGE_ROWS, PAGE_ROWS);
        pages.current.set(page, got.rows);
        bump((n) => n + 1);
      } catch (e) {
        setError(String(e));
      } finally {
        loading.current.delete(page);
      }
    },
    [docId]
  );

  const ensure = useCallback(
    (from: number, to: number) => {
      if (!docId || rowCount === 0) return;
      const last = Math.floor((rowCount - 1) / PAGE_ROWS);
      const first = Math.max(0, Math.floor(from / PAGE_ROWS) - AHEAD);
      const end = Math.min(last, Math.floor(to / PAGE_ROWS) + AHEAD);
      for (let p = first; p <= end; p++) void load(p);
    },
    [docId, rowCount, load]
  );

  const row = useCallback((index: number): string[] | null => {
    const page = pages.current.get(Math.floor(index / PAGE_ROWS));
    return page?.[index % PAGE_ROWS] ?? null;
  }, []);

  return { row, ensure, clear, error, version };
}
