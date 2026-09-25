/**
 * お気に入りのバックアップで「何を書き出すか」を選ぶときの判断。
 *
 * 選んでいるものは、項目 ("i:<ID>") と、中身の無いフォルダ ("f:<パス>") で持つ。
 * 中身のあるフォルダは、中の項目の選び方から「全部 / 一部 / なし」が決まるので持たない。
 * (フォルダに印を付けると中身が全部入り、外すと全部外れる)
 *
 * 画面から切り離しておくと、チェックの付き方だけを試せる
 */
import type { SavedSqlStore } from "./types";
import { isInside } from "./savedTree";

/** 選んでいるもの */
export type Selection = ReadonlySet<string>;

/** チェックボックスの状態 */
export type CheckState = "all" | "some" | "none";

/** 中にお気に入りが1件も無いフォルダ (下の階層も含めて見る) */
export function emptyFolders(store: SavedSqlStore): string[] {
  return store.folders.filter(
    (f) => !store.items.some((e) => isInside(e.folder, f))
  );
}

/** そのフォルダの中 (下の階層を含む) で選べるもの。"" ならすべて */
export function leavesInside(store: SavedSqlStore, path: string): string[] {
  const items = store.items
    .filter((e) => isInside(e.folder, path))
    .map((e) => `i:${e.id}`);
  const empties = emptyFolders(store)
    .filter((f) => isInside(f, path))
    .map((f) => `f:${f}`);
  return [...items, ...empties];
}

/** すべて選んだ状態 (開いたときの既定) */
export function selectAll(store: SavedSqlStore): Set<string> {
  return new Set(leavesInside(store, ""));
}

/** フォルダのチェックボックスの状態 */
export function folderCheck(
  store: SavedSqlStore,
  sel: Selection,
  path: string
): CheckState {
  const leaves = leavesInside(store, path);
  const n = leaves.filter((l) => sel.has(l)).length;
  if (n === 0) return "none";
  return n === leaves.length ? "all" : "some";
}

/**
 * フォルダの印を切り替える。
 * 全部選ばれていれば全部外し、そうでなければ全部選ぶ (一部のときも全部選ぶ)
 */
export function toggleFolder(
  store: SavedSqlStore,
  sel: Selection,
  path: string
): Set<string> {
  const leaves = leavesInside(store, path);
  const next = new Set(sel);
  if (folderCheck(store, sel, path) === "all") {
    for (const l of leaves) next.delete(l);
  } else {
    for (const l of leaves) next.add(l);
  }
  return next;
}

/** 項目の印を切り替える */
export function toggleItem(sel: Selection, id: string): Set<string> {
  const next = new Set(sel);
  const ref = `i:${id}`;
  if (next.has(ref)) next.delete(ref);
  else next.add(ref);
  return next;
}

/** 選んだお気に入りの数 (フォルダは数えない) */
export function selectedItemCount(sel: Selection): number {
  let n = 0;
  for (const r of sel) if (r.startsWith("i:")) n++;
  return n;
}

/** バックエンドへ渡す形 (項目のIDと、中身の無いフォルダのパス) */
export function exportPlan(sel: Selection): { ids: string[]; folders: string[] } {
  const ids: string[] = [];
  const folders: string[] = [];
  for (const r of sel) {
    if (r.startsWith("i:")) ids.push(r.slice(2));
    else if (r.startsWith("f:")) folders.push(r.slice(2));
  }
  return { ids, folders };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** バックアップのファイル名 (設定画面のバックアップと同じ形) */
export function backupFileName(d: Date): string {
  return `quelio_saved_sql_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
}

/** 復元先のフォルダ名の既定 */
export function restoreFolderName(d: Date): string {
  return `復元 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
