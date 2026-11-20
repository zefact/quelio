/**
 * ER図の「元に戻す / やり直す」の履歴。
 *
 * 図を変えて保存するたびに、変える前の図の中身 (スナップショット) を積む。
 * 戻すときは積んだものを取り出して画面へ戻す。
 * どれも元の履歴を書き換えず、新しい履歴を返す
 */
import type {
  ErAnchorPoint,
  ErCustomEdge,
  ErEdgeStyle,
  ErFrame,
  FkInfo,
  SchemaEntry,
} from "../types";

/** 覚えておく数の上限 (古いものから捨てる) */
export const HISTORY_LIMIT = 50;

export interface History<T> {
  /** 戻せる状態 (後ろほど新しい) */
  past: T[];
  /** やり直せる状態 (後ろほど近い) */
  future: T[];
}

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] };
}

/**
 * 変える前の状態を積む。
 * 新しく変えたので、やり直しの分は捨てる
 */
export function recordHistory<T>(
  h: History<T>,
  before: T,
  limit = HISTORY_LIMIT
): History<T> {
  const past = [...h.past, before];
  return { past: past.slice(Math.max(0, past.length - limit)), future: [] };
}

/** 1つ戻す。戻せないときは null */
export function undoHistory<T>(
  h: History<T>,
  current: T
): { history: History<T>; state: T } | null {
  if (h.past.length === 0) return null;
  const state = h.past[h.past.length - 1];
  return {
    history: { past: h.past.slice(0, -1), future: [...h.future, current] },
    state,
  };
}

/** 1つやり直す。やり直せないときは null */
export function redoHistory<T>(
  h: History<T>,
  current: T
): { history: History<T>; state: T } | null {
  if (h.future.length === 0) return null;
  const state = h.future[h.future.length - 1];
  return {
    history: { past: [...h.past, current], future: h.future.slice(0, -1) },
    state,
  };
}

/**
 * 履歴に積む図の中身 (1ページぶん)。
 * 表示位置 (パン・ズーム) は図の中身ではないので入れない
 */
export interface ErDoc {
  entries: SchemaEntry[];
  fks: FkInfo[];
  /** テーブル名 → 位置。積んだあとで書き換わらないよう、Map でなく写しを持つ */
  positions: Record<string, { x: number; y: number }>;
  options: { allCols: boolean; showLogical: boolean; showTypes: boolean };
  removedEdges: Set<string>;
  removedTables: Set<string>;
  manualTables: Set<string>;
  tableWidths: Record<string, number>;
  customEdges: ErCustomEdge[];
  anchors: Record<string, { from?: ErAnchorPoint; to?: ErAnchorPoint }>;
  edgeColumns: Record<string, { from: string[]; to: string[] }>;
  edgeStyles: Record<string, ErEdgeStyle>;
  columnColors: Record<string, string>;
  frames: ErFrame[];
}

/** 位置の一覧が同じか (動かしたかどうか) */
function samePositions(
  a: Record<string, { x: number; y: number }>,
  b: Record<string, { x: number; y: number }>
): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] && a[k].x === b[k].x && a[k].y === b[k].y);
}

/** 同じ一覧か (空の一覧は毎回新しく作られることがあるので、空同士も同じとみなす) */
function sameList<T>(a: T[], b: T[]): boolean {
  return a === b || (a.length === 0 && b.length === 0);
}

/**
 * 図の中身が同じか。
 *
 * 位置と表示設定は中身を比べる (毎回新しく作られるため)。
 * ほかは変えるたびに新しい値に差し替えているので、同じものかどうかだけを見る
 * (大きな図でも、表示を動かしただけの保存で重くならないように)
 */
export function sameErDoc(a: ErDoc, b: ErDoc): boolean {
  return (
    sameList(a.entries, b.entries) &&
    sameList(a.fks, b.fks) &&
    a.removedEdges === b.removedEdges &&
    a.removedTables === b.removedTables &&
    a.manualTables === b.manualTables &&
    a.tableWidths === b.tableWidths &&
    a.customEdges === b.customEdges &&
    a.anchors === b.anchors &&
    a.edgeColumns === b.edgeColumns &&
    a.edgeStyles === b.edgeStyles &&
    a.columnColors === b.columnColors &&
    a.frames === b.frames &&
    a.options.allCols === b.options.allCols &&
    a.options.showLogical === b.options.showLogical &&
    a.options.showTypes === b.options.showTypes &&
    samePositions(a.positions, b.positions)
  );
}

/**
 * 保存用の内容から、履歴に積む形を作る。
 * 位置は動かすたびに同じ Map を書き換えているので、ここで写しを取る
 */
export function toErDoc(
  s: Omit<ErDoc, "positions"> & {
    positions: Map<string, { x: number; y: number }>;
  }
): ErDoc {
  return {
    entries: s.entries,
    fks: s.fks,
    positions: Object.fromEntries(
      [...s.positions].map(([k, p]) => [k, { x: p.x, y: p.y }])
    ),
    options: { ...s.options },
    removedEdges: s.removedEdges,
    removedTables: s.removedTables,
    manualTables: s.manualTables,
    tableWidths: s.tableWidths,
    customEdges: s.customEdges,
    anchors: s.anchors,
    edgeColumns: s.edgeColumns,
    edgeStyles: s.edgeStyles,
    columnColors: s.columnColors,
    frames: s.frames,
  };
}
