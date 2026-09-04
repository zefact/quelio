import { useCallback, useEffect, useRef, useState } from "react";
import { csvDiffPage } from "../api";
import type { CsvDiffRow } from "../types";

/**
 * 比較結果の行を、見えているぶんだけ取ってくる。
 *
 * `useCsvRows` と考え方は同じだが、取ってくるものが
 * 「1つのファイルの行」ではなく「左右を突き合わせた行」なので分けてある
 */

/** 1回に取りに行く行数 */
export const DIFF_PAGE_ROWS = 300;

/** 見えている範囲の前後に、あらかじめ取っておくページ数 */
const AHEAD = 1;

export interface CsvDiffRows {
  /** 行位置から差分を引く (まだ取れていなければ null) */
  row: (index: number) => CsvDiffRow | null;
  ensure: (from: number, to: number) => void;
  clear: () => void;
  error: string | null;
}

export function useCsvDiffRows(
  /** 比較をやり直すたびに変える値 (溜めたものを捨てる目印) */
  token: number,
  total: number
): CsvDiffRows {
  const pages = useRef(new Map<number, CsvDiffRow[]>());
  const loading = useRef(new Set<number>());
  const [, bump] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const clear = useCallback(() => {
    pages.current.clear();
    loading.current.clear();
    bump((n) => n + 1);
  }, []);

  useEffect(() => {
    clear();
    setError(null);
  }, [token, clear]);

  const load = useCallback(async (page: number) => {
    if (pages.current.has(page) || loading.current.has(page)) return;
    loading.current.add(page);
    try {
      const got = await csvDiffPage(page * DIFF_PAGE_ROWS, DIFF_PAGE_ROWS);
      pages.current.set(page, got.rows);
      bump((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      loading.current.delete(page);
    }
  }, []);

  const ensure = useCallback(
    (from: number, to: number) => {
      if (total === 0) return;
      const last = Math.floor((total - 1) / DIFF_PAGE_ROWS);
      const first = Math.max(0, Math.floor(from / DIFF_PAGE_ROWS) - AHEAD);
      const end = Math.min(last, Math.floor(to / DIFF_PAGE_ROWS) + AHEAD);
      for (let p = first; p <= end; p++) void load(p);
    },
    [total, load]
  );

  const row = useCallback((index: number): CsvDiffRow | null => {
    const page = pages.current.get(Math.floor(index / DIFF_PAGE_ROWS));
    return page?.[index % DIFF_PAGE_ROWS] ?? null;
  }, []);

  return { row, ensure, clear, error };
}
