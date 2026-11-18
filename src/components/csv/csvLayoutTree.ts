/**
 * お気に入り (固定長の桁設定・列名の並び) を、フォルダ分けして並べるための計算。
 *
 * 画面から切り離してここに置いてあるので、そのまま試験できる。
 * フォルダは1階層まで。フォルダに入れていないものは一番上の並びにそのまま置く。
 * 中身が違っても並べ方は同じなので、名前を持つものなら何でも扱える
 */
import type { CsvSavedLayout, FavNode } from "../../types";

/** 並べられるもの (名前で見分ける) */
export interface Named {
  name: string;
}

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
export type LayoutRow<T extends Named = CsvSavedLayout> =
  | { type: "folder"; name: string; at: number; count: number }
  | {
      type: "item";
      saved: T;
      /** 入っているフォルダの名前 (入れていなければ null) */
      folder: string | null;
      /** その並びの何番目か */
      at: number;
    };

/** 木を、並んでいる順のお気に入りの一覧にする */
export function flatLayouts<T extends Named>(nodes: FavNode<T>[]): T[] {
  const out: T[] = [];
  for (const n of nodes) {
    if (n.kind === "folder") out.push(...n.items);
    else out.push(savedOf(n));
  }
  return out;
}

/** フォルダの名前を、並んでいる順に */
export function folderNames<T extends Named>(nodes: FavNode<T>[]): string[] {
  return nodes.flatMap((n) => (n.kind === "folder" ? [n.name] : []));
}

/** 木を、画面に出す行の並びにする (フォルダの次にその中身) */
export function rowsOf<T extends Named>(nodes: FavNode<T>[]): LayoutRow<T>[] {
  const rows: LayoutRow<T>[] = [];
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
 * 閉じているフォルダの中身を除いた、画面に出す行。
 *
 * 掴んで動かすときの当たり判定も、この並び (画面に出ている行) で行う
 */
export function visibleRows<T extends Named>(
  rows: LayoutRow<T>[],
  /** 閉じているフォルダの名前 */
  closed: ReadonlySet<string>
): LayoutRow<T>[] {
  return rows.filter(
    (r) => r.type === "folder" || r.folder === null || !closed.has(r.folder)
  );
}

/**
 * その行の上で放したとき、どこへ入るか (入れられないなら null)。
 *
 * `upper` は行の上半分にいるかどうか。
 * お気に入りをフォルダの行へ放したときは、そのフォルダの中へ入れる
 */
export function spotAt<T extends Named>(
  row: LayoutRow<T>,
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
export function endSpot<T extends Named>(nodes: FavNode<T>[]): LayoutSpot {
  return { folder: null, index: nodes.length };
}

/** 掴んでいるものを、その場所へ動かす */
export function applyMove<T extends Named>(
  nodes: FavNode<T>[],
  drag: LayoutDrag,
  spot: LayoutSpot
): FavNode<T>[] {
  return drag.type === "folder"
    ? moveFolder(nodes, drag.name, spot)
    : moveItem(nodes, drag.name, spot);
}

/** フォルダを作る (一番下へ) */
export function addFolder<T extends Named>(
  nodes: FavNode<T>[],
  name: string
): FavNode<T>[] {
  return [...clone(nodes), { kind: "folder", name, items: [] }];
}

/** フォルダの名前を変える */
export function renameFolder<T extends Named>(
  nodes: FavNode<T>[],
  from: string,
  to: string
): FavNode<T>[] {
  return clone(nodes).map((n) =>
    n.kind === "folder" && n.name === from ? { ...n, name: to } : n
  );
}

/** フォルダを外す (中身はその場所へ出す。お気に入りは消さない) */
export function removeFolder<T extends Named>(
  nodes: FavNode<T>[],
  name: string
): FavNode<T>[] {
  const out: FavNode<T>[] = [];
  for (const n of clone(nodes)) {
    if (n.kind === "folder" && n.name === name) {
      out.push(...n.items.map((saved) => item(saved)));
    } else {
      out.push(n);
    }
  }
  return out;
}

/**
 * お気に入り1件を、その場所のまま差し替える (名前・桁設定の変更)。
 *
 * 並びの場所と入っているフォルダは変えない。
 * 元の名前のものが無ければ null (一覧から消えていた、など)
 */
export function replaceLayout<T extends Named>(
  nodes: FavNode<T>[],
  from: string,
  saved: T
): FavNode<T>[] | null {
  let done = false;
  const out = clone(nodes).map((n): FavNode<T> => {
    if (n.kind === "folder") {
      const items = n.items.map((s) => {
        if (s.name !== from) return s;
        done = true;
        return saved;
      });
      return { ...n, items };
    }
    if (n.name !== from) return n;
    done = true;
    return item(saved);
  });
  return done ? out : null;
}

/** その名前が既に使われているか (フォルダ名とお気に入り名は別々に見る) */
export function usedName<T extends Named>(
  nodes: FavNode<T>[],
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

/** 一番上の並びの節から、お気に入りそのものを取り出す (節の印 kind を外す) */
function savedOf<T extends Named>(node: FavNode<T>): T {
  if (node.kind === "folder") throw new Error("フォルダにはお気に入りが入る");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { kind, ...saved } = node;
  return saved as unknown as T;
}

function item<T extends Named>(saved: T): FavNode<T> {
  return { kind: "item", ...saved };
}

function clone<T extends Named>(nodes: FavNode<T>[]): FavNode<T>[] {
  return nodes.map((n) =>
    n.kind === "folder" ? { ...n, items: [...n.items] } : { ...n }
  );
}

function clamp(i: number, max: number): number {
  return Math.max(0, Math.min(i, max));
}

function moveItem<T extends Named>(
  nodes: FavNode<T>[],
  name: string,
  spot: LayoutSpot
): FavNode<T>[] {
  const out = clone(nodes);
  let saved: T | null = null;
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

function moveFolder<T extends Named>(
  nodes: FavNode<T>[],
  name: string,
  spot: LayoutSpot
): FavNode<T>[] {
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
