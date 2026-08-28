import type { ClippedCell } from "./types";

/**
 * セル値の切り詰め。
 *
 * バックエンド (query.rs の clip_cell) は長すぎる値を
 * 「先頭N文字 + … (全M文字)」にして返す。注記を値の中に残しているのは、
 * グリッドのコピーがDOMの文字列を読むためで、ここを消すと
 * 切り詰められたことに気づかないままコピーされてしまう。
 *
 * ただし「切り詰められたかどうか」の判定に、この注記を文字列として
 * 読み戻してはいけない (文言を変えただけで壊れる)。
 * バックエンドが位置を `QueryResult.clipped` として別に返すので、そちらを使う
 */

/** 切り詰められた1セルの長さ */
export interface Clip {
  /** 注記を除いた、実際に入っている先頭の文字数 */
  head: number;
  /** 切り詰める前の全体の文字数 */
  total: number;
}

/** (行, 列) から切り詰めを引く関数を作る (無ければ null を返す) */
export function clipIndex(
  clipped: ClippedCell[] | undefined
): (row: number, col: number) => Clip | null {
  if (!clipped || clipped.length === 0) return () => null;
  const map = new Map<string, Clip>();
  for (const c of clipped) {
    map.set(`${c.row}:${c.col}`, { head: c.head, total: c.total });
  }
  return (row, col) => map.get(`${row}:${col}`) ?? null;
}

/** 切り詰められた値がある行のキー (グリッドのコピーの注記に使う) */
export function clippedRowKeys(clipped: ClippedCell[] | undefined): Set<string> {
  return new Set((clipped ?? []).map((c) => String(c.row)));
}

/** 切り詰めの注記を外した本文 (先頭部分) */
export function clippedHead(value: string, clip: Clip | null): string {
  if (!clip) return value;
  // 文字数は Rust 側の数え方 (コードポイント) に合わせる
  return [...value].slice(0, clip.head).join("");
}
