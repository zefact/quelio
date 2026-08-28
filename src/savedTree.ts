/**
 * お気に入り (保存SQL) のフォルダ構造と、ドラッグの落とし先の計算。
 *
 * 画面から切り離しておくと、
 * 「どこへ落としたら何番目になるか」だけをテストできる。
 * 位置の数え方はバックエンド (saved_sql.rs) と合わせてある:
 * 動かすもの自身を一度取り除いた並びの中で、何番目に差し込むか
 */
import type { SavedSqlEntry, SavedSqlStore } from "./types";

/** フォルダ1つと、その直下の中身 */
export interface SavedNode {
  /** ルートからのパス ("集計/月次")。ルート自身は空文字 */
  path: string;
  name: string;
  folders: SavedNode[];
  items: SavedSqlEntry[];
}

/** 1つ上のフォルダ (ルート直下なら空文字) */
export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** 末尾の名前 */
export function nameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** `path` が `of` 自身か、その下にあるか */
export function isInside(path: string, of: string): boolean {
  if (!of) return true;
  return path === of || path.startsWith(`${of}/`);
}

/** 指定フォルダの直下にあるフォルダ (保存されている並びのまま) */
export function childFolders(store: SavedSqlStore, parent: string): string[] {
  return store.folders.filter((f) => parentOf(f) === parent);
}

/** 指定フォルダの中の項目 (保存されている並びのまま) */
export function itemsIn(store: SavedSqlStore, folder: string): SavedSqlEntry[] {
  return store.items.filter((e) => e.folder === folder);
}

/** 表示用のツリーを組み立てる */
export function buildTree(store: SavedSqlStore): SavedNode {
  const make = (path: string): SavedNode => ({
    path,
    name: nameOf(path),
    folders: childFolders(store, path).map(make),
    items: itemsIn(store, path),
  });
  return make("");
}

/** ドラッグしているもの */
export type DragRef =
  | { type: "item"; id: string }
  | { type: "folder"; path: string };

/** 落とそうとしている場所 */
export type DropSpot =
  /** 項目の前/後ろ */
  | { type: "before" | "after"; kind: "item"; id: string }
  /** フォルダの前/後ろ */
  | { type: "before" | "after"; kind: "folder"; path: string }
  /** フォルダの中へ */
  | { type: "into"; path: string }
  /** 一番下の余白 (ルートの末尾) */
  | { type: "root-end" }
  /** 置けない場所 (どの行かは印を出すために持つ) */
  | { type: "denied"; key: string };

/** ドラッグの結果 (バックエンドへ渡す形) */
export type DropResult =
  | { kind: "item"; id: string; folder: string; index: number }
  | { kind: "folder"; path: string; parent: string; index: number };

/** 動かすもの自身を除いた並びの中での位置を出す */
function insertIndex(
  siblings: string[],
  targetKey: string,
  after: boolean
): number {
  const at = siblings.indexOf(targetKey);
  if (at < 0) return siblings.length;
  return after ? at + 1 : at;
}

/**
 * 落とし先から「どこへ何番目で入れるか」を決める。
 * 置けないときは null
 */
export function resolveDrop(
  store: SavedSqlStore,
  drag: DragRef,
  spot: DropSpot
): DropResult | null {
  if (spot.type === "denied") return null;

  if (drag.type === "item") {
    const others = (folder: string) =>
      itemsIn(store, folder)
        .filter((e) => e.id !== drag.id)
        .map((e) => e.id);
    if (spot.type === "root-end") {
      return { kind: "item", id: drag.id, folder: "", index: others("").length };
    }
    if (spot.type === "into") {
      // フォルダの中は末尾へ
      return {
        kind: "item",
        id: drag.id,
        folder: spot.path,
        index: others(spot.path).length,
      };
    }
    if (spot.kind === "item") {
      if (spot.id === drag.id) return null;
      const target = store.items.find((e) => e.id === spot.id);
      if (!target) return null;
      return {
        kind: "item",
        id: drag.id,
        folder: target.folder,
        index: insertIndex(others(target.folder), spot.id, spot.type === "after"),
      };
    }
    // フォルダ行の前後 = そのフォルダと同じ階層へ置く
    const folder = parentOf(spot.path);
    return { kind: "item", id: drag.id, folder, index: others(folder).length };
  }

  // --- フォルダを動かす ---
  const others = (parent: string) =>
    childFolders(store, parent).filter((f) => f !== drag.path);

  if (spot.type === "root-end") {
    // 既にルート直下なら末尾へ、そうでなければルートへ出す
    return { kind: "folder", path: drag.path, parent: "", index: others("").length };
  }
  if (spot.type === "into") {
    // 自分自身の中へは入れられない
    if (isInside(spot.path, drag.path)) return null;
    return {
      kind: "folder",
      path: drag.path,
      parent: spot.path,
      index: others(spot.path).length,
    };
  }
  if (spot.kind === "folder") {
    if (spot.path === drag.path) return null;
    // 自分の下にあるフォルダの前後へは動かせない
    if (isInside(spot.path, drag.path)) return null;
    const parent = parentOf(spot.path);
    return {
      kind: "folder",
      path: drag.path,
      parent,
      index: insertIndex(others(parent), spot.path, spot.type === "after"),
    };
  }
  // 項目の前後 = その項目と同じ階層へ置く
  const target = store.items.find((e) => e.id === spot.id);
  if (!target) return null;
  if (isInside(target.folder, drag.path)) return null;
  return {
    kind: "folder",
    path: drag.path,
    parent: target.folder,
    index: others(target.folder).length,
  };
}
