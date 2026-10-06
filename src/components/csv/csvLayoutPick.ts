/**
 * 固定長のお気に入りのバックアップ・復元で「どれを選ぶか」の判断。
 *
 * 選んでいるものは、お気に入り ("i:<名前>") と、中身の無いフォルダ ("f:<名前>") で持つ。
 * 中身のあるフォルダは、中のお気に入りの選び方から「全部 / 一部 / なし」が決まるので持たない
 * (フォルダに印を付けると中身が全部入り、外すと全部外れる)。
 *
 * 画面から切り離しておくと、チェックの付き方だけを試せる
 */
import type {
  CsvLayoutFileEntry,
  CsvLayoutImported,
  CsvLayoutNode,
} from "../../types";

/** チェックボックスの状態 */
export type PickState = "all" | "some" | "none";

/** そのフォルダで選べるもの (中身が無ければフォルダ自身) */
function leavesOf(node: CsvLayoutNode): string[] {
  if (node.kind !== "folder") return [`i:${node.name}`];
  return node.items.length > 0
    ? node.items.map((s) => `i:${s.name}`)
    : [`f:${node.name}`];
}

/** すべて選んだ状態 (開いたときの既定) */
export function pickAll(nodes: CsvLayoutNode[]): Set<string> {
  return new Set(nodes.flatMap(leavesOf));
}

/** フォルダのチェックボックスの状態 */
export function folderPick(
  node: CsvLayoutNode,
  sel: ReadonlySet<string>
): PickState {
  const leaves = leavesOf(node);
  const n = leaves.filter((l) => sel.has(l)).length;
  if (n === 0) return "none";
  return n === leaves.length ? "all" : "some";
}

/**
 * フォルダの印を切り替える。
 * 全部選ばれていれば全部外し、そうでなければ全部選ぶ (一部のときも全部選ぶ)
 */
export function toggleFolderPick(
  node: CsvLayoutNode,
  sel: ReadonlySet<string>
): Set<string> {
  const next = new Set(sel);
  const leaves = leavesOf(node);
  const all = leaves.every((l) => next.has(l));
  for (const l of leaves) {
    if (all) next.delete(l);
    else next.add(l);
  }
  return next;
}

/** 印を1つ付け外しする */
export function togglePick(sel: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(sel);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** 選んでいるお気に入りの数 (フォルダは数えない) */
export function pickedCount(sel: ReadonlySet<string>): number {
  return [...sel].filter((k) => k.startsWith("i:")).length;
}

/** 書き出すもの (お気に入りの名前と、中身の無いフォルダの名前) */
export function exportPick(sel: ReadonlySet<string>): {
  names: string[];
  folders: string[];
} {
  const names: string[] = [];
  const folders: string[] = [];
  for (const k of sel) {
    if (k.startsWith("i:")) names.push(k.slice(2));
    else if (k.startsWith("f:")) folders.push(k.slice(2));
  }
  return { names, folders };
}

/** バックアップの既定のファイル名 (設定画面のバックアップと同じ形) */
export function layoutBackupFileName(d: Date): string {
  const p2 = (v: number) => String(v).padStart(2, "0");
  return `quelio_csv_layouts_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.json`;
}

/** 復元の一覧に出すまとまり (取り込み先のフォルダごと。並びはファイルの順) */
export interface RestoreGroup {
  /** 取り込み先のフォルダ (フォルダに入らないものは null) */
  folder: string | null;
  /** ファイルの中での名前と違うとき (同じ名前のフォルダがあったとき) の元の名前 */
  renamedFrom: string | null;
  entries: CsvLayoutFileEntry[];
}

/** ファイルの中身を、取り込み先のフォルダごとにまとめる */
export function restoreGroups(entries: CsvLayoutFileEntry[]): RestoreGroup[] {
  const groups: RestoreGroup[] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    // フォルダの外のものは1つずつ並べ、フォルダの中のものは続けてまとめる
    if (e.saveFolder !== null && last && last.folder === e.saveFolder) {
      last.entries.push(e);
      continue;
    }
    groups.push({
      folder: e.saveFolder,
      renamedFrom:
        e.saveFolder !== null && e.folder !== e.saveFolder ? e.folder : null,
      entries: [e],
    });
  }
  return groups;
}

/** 取り込んだあとの知らせ */
export function layoutImportedNotice(done: CsvLayoutImported[]): string {
  if (done.length === 0) return "取り込んだお気に入りはありません";
  const renamed = done.filter((d) => d.savedAs !== d.name).length;
  return (
    `固定長のお気に入りを${done.length}件取り込みました` +
    (renamed > 0 ? ` (同じ名前の${renamed}件は番号を付けて追加)` : "")
  );
}
