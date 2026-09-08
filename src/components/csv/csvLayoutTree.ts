/**
 * 固定長のお気に入りを、フォルダ分けして並べるための計算。
 *
 * 画面から切り離してここに置いてあるので、そのまま試験できる。
 * フォルダは1階層まで。フォルダに入れていないものは一番上の並びにそのまま置く
 */
import type { CsvLayoutNode, CsvSavedLayout } from "../../types";

/** 入れる場所 (folder が null なら一番上の並び) */
export interface LayoutSpot {
  folder: string | null;
  /** その並びの何番目に入れるか */
  index: number;
}

/** 掴んでいるもの */
export type LayoutDrag =
  | { type: "item"; name: string }
  | { type: "folder"; name: string };

/** 画面に出す1行 (フォルダの行か、お気に入りの行) */
export type LayoutRow =
  | { type: "folder"; name: string; at: number; count: number }
  | {
      type: "item";
      saved: CsvSavedLayout;
      /** 入っているフォルダの名前 (入れていなければ null) */
      folder: string | null;
      /** その並びの何番目か */
      at: number;
    };

/** 木を、並んでいる順のお気に入りの一覧にする */
export function flatLayouts(nodes: CsvLayoutNode[]): CsvSavedLayout[] {
  const out: CsvSavedLayout[] = [];
  for (const n of nodes) {
    if (n.kind === "folder") out.push(...n.items);
    else out.push(savedOf(n));
  }
  return out;
}

/** フォルダの名前を、並んでいる順に */
export function folderNames(nodes: CsvLayoutNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === "folder" ? [n.name] : []));
}

/** 木を、画面に出す行の並びにする (フォルダの次にその中身) */
export function rowsOf(nodes: CsvLayoutNode[]): LayoutRow[] {
  const rows: LayoutRow[] = [];
  nodes.forEach((n, at) => {
    if (n.kind === "folder") {
      rows.push({ type: "folder", name: n.name, at, count: n.items.length });
      n.items.forEach((saved, i) =>
        rows.push({ type: "item", saved, folder: n.name, at: i })
      );
    } else {
      rows.push({ type: "item", saved: savedOf(n), folder: null, at });
    }
  });
  return rows;
}

/**
 * その行の上で放したとき、どこへ入るか (入れられないなら null)。
 *
 * `upper` は行の上半分にいるかどうか。
 * お気に入りをフォルダの行へ放したときは、そのフォルダの中へ入れる
 */
export function spotAt(
  row: LayoutRow,
  upper: boolean,
  drag: LayoutDrag
): LayoutSpot | null {
  if (drag.type === "folder") {
    // フォルダの中にフォルダは入れない
    if (row.type === "item" && row.folder !== null) return null;
    const at = row.at;
    return { folder: null, index: upper ? at : at + 1 };
  }
  if (row.type === "folder") return { folder: row.name, index: row.count };
  return { folder: row.folder, index: upper ? row.at : row.at + 1 };
}

/**
 * 縦に並んだ行の中で、その高さがどの行のどちら側かを求める。
 *
 * どの行にも掛かっていなければ null (一番下より下、など)
 */
export function hitRow(
  /** 行の上端と高さ (画面での位置。並び順どおり) */
  boxes: { top: number; height: number }[],
  y: number
): { index: number; upper: boolean } | null {
  for (const [index, box] of boxes.entries()) {
    if (y < box.top || y >= box.top + box.height) continue;
    return { index, upper: y - box.top < box.height / 2 };
  }
  return null;
}

/** 一番下 (どのフォルダにも入れず、末尾へ) */
export function endSpot(nodes: CsvLayoutNode[]): LayoutSpot {
  return { folder: null, index: nodes.length };
}

/** 掴んでいるものを、その場所へ動かす */
export function applyMove(
  nodes: CsvLayoutNode[],
  drag: LayoutDrag,
  spot: LayoutSpot
): CsvLayoutNode[] {
  return drag.type === "folder"
    ? moveFolder(nodes, drag.name, spot)
    : moveItem(nodes, drag.name, spot);
}

/** フォルダを作る (一番下へ) */
export function addFolder(
  nodes: CsvLayoutNode[],
  name: string
): CsvLayoutNode[] {
  return [...clone(nodes), { kind: "folder", name, items: [] }];
}

/** フォルダの名前を変える */
export function renameFolder(
  nodes: CsvLayoutNode[],
  from: string,
  to: string
): CsvLayoutNode[] {
  return clone(nodes).map((n) =>
    n.kind === "folder" && n.name === from ? { ...n, name: to } : n
  );
}

/** フォルダを外す (中身はその場所へ出す。お気に入りは消さない) */
export function removeFolder(
  nodes: CsvLayoutNode[],
  name: string
): CsvLayoutNode[] {
  const out: CsvLayoutNode[] = [];
  for (const n of clone(nodes)) {
    if (n.kind === "folder" && n.name === name) {
      out.push(...n.items.map((saved) => item(saved)));
    } else {
      out.push(n);
    }
  }
  return out;
}

/** その名前が既に使われているか (フォルダ名とお気に入り名は別々に見る) */
export function usedName(
  nodes: CsvLayoutNode[],
  name: string,
  kind: "folder" | "item"
): boolean {
  const used =
    kind === "folder"
      ? folderNames(nodes)
      : flatLayouts(nodes).map((s) => s.name);
  return used.includes(name);
}

// ---------- ここから下は中で使うもの ----------

function savedOf(node: CsvLayoutNode): CsvSavedLayout {
  if (node.kind === "folder") throw new Error("フォルダにはお気に入りが入る");
  const { name, layout, updatedAtMs } = node;
  return { name, layout, updatedAtMs };
}

function item(saved: CsvSavedLayout): CsvLayoutNode {
  return { kind: "item", ...saved };
}

function clone(nodes: CsvLayoutNode[]): CsvLayoutNode[] {
  return nodes.map((n) =>
    n.kind === "folder" ? { ...n, items: [...n.items] } : { ...n }
  );
}

function clamp(i: number, max: number): number {
  return Math.max(0, Math.min(i, max));
}

function moveItem(
  nodes: CsvLayoutNode[],
  name: string,
  spot: LayoutSpot
): CsvLayoutNode[] {
  const out = clone(nodes);
  let saved: CsvSavedLayout | null = null;
  let from: string | null = null;
  let at = -1;

  const top = out.findIndex((n) => n.kind === "item" && n.name === name);
  if (top >= 0) {
    saved = savedOf(out[top]);
    at = top;
    out.splice(top, 1);
  } else {
    for (const n of out) {
      if (n.kind !== "folder") continue;
      const i = n.items.findIndex((s) => s.name === name);
      if (i < 0) continue;
      saved = n.items[i];
      from = n.name;
      at = i;
      n.items.splice(i, 1);
      break;
    }
  }
  if (!saved) return nodes;

  // 抜いたぶん、後ろの位置が1つずれる
  let index = spot.index;
  if (from === spot.folder && at < index) index -= 1;

  if (spot.folder === null) {
    out.splice(clamp(index, out.length), 0, item(saved));
    return out;
  }
  const folder = out.find((n) => n.kind === "folder" && n.name === spot.folder);
  if (!folder || folder.kind !== "folder") return nodes;
  folder.items.splice(clamp(index, folder.items.length), 0, saved);
  return out;
}

function moveFolder(
  nodes: CsvLayoutNode[],
  name: string,
  spot: LayoutSpot
): CsvLayoutNode[] {
  if (spot.folder !== null) return nodes;
  const out = clone(nodes);
  const at = out.findIndex((n) => n.kind === "folder" && n.name === name);
  if (at < 0) return nodes;
  const [node] = out.splice(at, 1);
  let index = spot.index;
  if (at < index) index -= 1;
  out.splice(clamp(index, out.length), 0, node);
  return out;
}
