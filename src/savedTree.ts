/**
 * お気に入り (保存SQL) のフォルダ構造と、ドラッグの落とし先の計算。
 *
 * 表示順は保存側が持っている1本の並び (store.order) で決まる。
 * フォルダと項目が同じ並びに載っているので、
 * 「フォルダ・項目・フォルダ」のような順番も作れる。
 *
 * 画面から切り離しておくと、
 * 「どこへ落としたら、どの要素の前に入るか」だけをテストできる
 */
import type { SavedSqlEntry, SavedSqlStore } from "./types";

/** 並びに載せる呼び名 ("f:パス" / "i:ID")。保存側 (saved_sql.rs) と同じ形 */
export type NodeRef = string;

export function folderRef(path: string): NodeRef {
  return `f:${path}`;
}

export function itemRef(id: string): NodeRef {
  return `i:${id}`;
}

/** 呼び名がフォルダなら、そのパスを返す */
export function refFolderPath(ref: NodeRef): string | null {
  return ref.startsWith("f:") ? ref.slice(2) : null;
}

/** フォルダ1つと、その直下の中身 (表示順のまま) */
export interface SavedNode {
  /** ルートからのパス ("集計/月次")。ルート自身は空文字 */
  path: string;
  name: string;
  children: SavedChild[];
}

/** 直下の要素 (フォルダか項目) */
export type SavedChild =
  | { kind: "folder"; node: SavedNode }
  | { kind: "item"; entry: SavedSqlEntry };

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

/** 呼び名の親フォルダ (知らない呼び名なら null) */
export function refParent(store: SavedSqlStore, ref: NodeRef): string | null {
  const folder = refFolderPath(ref);
  if (folder !== null) {
    return store.folders.includes(folder) ? parentOf(folder) : null;
  }
  const id = ref.slice(2);
  return store.items.find((e) => e.id === id)?.folder ?? null;
}

/**
 * 指定フォルダの直下にあるものを、表示順のまま返す。
 *
 * 保存側の並びは1本なので、親でふるいにかけるだけで
 * その階層の並びになる (兄弟でないものが間に挟まっていてもよい)
 */
export function childRefs(store: SavedSqlStore, parent: string): NodeRef[] {
  return store.order.filter((r) => refParent(store, r) === parent);
}

/** 表示用のツリーを組み立てる */
export function buildTree(store: SavedSqlStore): SavedNode {
  const byId = new Map(store.items.map((e) => [e.id, e]));
  const make = (path: string): SavedNode => ({
    path,
    name: nameOf(path),
    children: childRefs(store, path).flatMap((ref): SavedChild[] => {
      const folder = refFolderPath(ref);
      if (folder !== null) return [{ kind: "folder", node: make(folder) }];
      const entry = byId.get(ref.slice(2));
      return entry ? [{ kind: "item", entry }] : [];
    }),
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

/**
 * ドラッグの結果 (バックエンドへ渡す形)。
 * 位置は番号ではなく「この要素の直前へ」で表す
 */
export interface DropResult {
  node: NodeRef;
  parent: string;
  /** この要素の直前へ入れる (null なら末尾) */
  before: NodeRef | null;
}

/** 掴んでいるものの呼び名 */
function dragRefOf(drag: DragRef): NodeRef {
  return drag.type === "item" ? itemRef(drag.id) : folderRef(drag.path);
}

/** 落とし先の行の呼び名 */
function spotRefOf(
  spot: Extract<DropSpot, { type: "before" | "after" }>
): NodeRef {
  return spot.kind === "item" ? itemRef(spot.id) : folderRef(spot.path);
}

/**
 * 落とし先から「どのフォルダの、どの要素の前へ入れるか」を決める。
 * 置けないときは null
 */
export function resolveDrop(
  store: SavedSqlStore,
  drag: DragRef,
  spot: DropSpot
): DropResult | null {
  if (spot.type === "denied") return null;
  const node = dragRefOf(drag);
  /** 掴んでいるフォルダの中か (フォルダを自分の中へは入れられない) */
  const intoSelf = (parent: string) =>
    drag.type === "folder" && isInside(parent, drag.path);
  /** 掴んでいるもの自身を除いた、その階層の並び */
  const siblings = (parent: string) =>
    childRefs(store, parent).filter((r) => r !== node);

  if (spot.type === "root-end") {
    return { node, parent: "", before: null };
  }
  if (spot.type === "into") {
    if (intoSelf(spot.path)) return null;
    // フォルダの中へ落としたときは末尾に入れる
    return { node, parent: spot.path, before: null };
  }

  const target = spotRefOf(spot);
  if (target === node) return null;
  const parent = refParent(store, target);
  // 一覧に無いものを指していた場合は何もしない
  if (parent === null) return null;
  if (intoSelf(parent)) return null;

  const list = siblings(parent);
  const at = list.indexOf(target);
  if (at < 0) return null;
  const before = spot.type === "before" ? target : (list[at + 1] ?? null);
  return { node, parent, before };
}
