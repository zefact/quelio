/**
 * ER図で「いま何を選んでいるか」。
 *
 * リレーション・テーブル・カラム行・矩形選択の4つは、
 * 背景クリックや図の読み込みでまとめて解除する。
 * 別々に持っていると解除の書き漏らしが起きるので、ここにまとめる
 */
import { useCallback, useState } from "react";

/** 矩形選択の範囲 (図の座標) */
export interface ErBand {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 選択中のカラム行 */
export interface ErColumnRef {
  table: string;
  column: string;
}

export function useErSelection() {
  /** 選択中のリレーション (edgesのindex) */
  const [selEdge, setSelEdge] = useState<number | null>(null);
  /** 複数選択中のリレーション (Shift+ドラッグの矩形選択で入る) */
  const [selEdges, setSelEdges] = useState<Set<number>>(new Set());
  /** 選択中のテーブル (複数可) */
  const [selNodes, setSelNodes] = useState<Set<string>>(new Set());
  /** 矩形選択中の範囲 */
  const [band, setBand] = useState<ErBand | null>(null);
  /** 選択中のカラム行 (もう一度クリック/背景クリックで解除) */
  const [selCol, setSelCol] = useState<ErColumnRef | null>(null);

  /** すべての選択を解除する (背景クリック・図の読み込み) */
  const clearAll = useCallback(() => {
    setSelEdge(null);
    setSelEdges(new Set());
    setSelNodes(new Set());
    setSelCol(null);
  }, []);

  return {
    selEdge,
    setSelEdge,
    selEdges,
    setSelEdges,
    selNodes,
    setSelNodes,
    band,
    setBand,
    selCol,
    setSelCol,
    clearAll,
  };
}
