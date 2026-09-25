/**
 * ER図のバックアップ・復元 (図のメニューから使う) の小道具。
 * 画面に依存しない部分だけを置く
 */
import type { ErFileEntry, ErImported } from "../types";

/** バックアップの既定のファイル名 (設定画面のバックアップと同じ形) */
export function erBackupFileName(d: Date): string {
  const p2 = (v: number) => String(v).padStart(2, "0");
  return `quelio_er_diagrams_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.json`;
}

/** 印の付け外し (新しいSetを返す) */
export function toggleName(sel: Set<string>, name: string): Set<string> {
  const next = new Set(sel);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

/** ファイルの中の図の説明 (「2ページ・12テーブル」) */
export function entryMeta(e: ErFileEntry): string {
  return e.pages > 1 ? `${e.pages}ページ・${e.tables}テーブル` : `${e.tables}テーブル`;
}

/** 取り込んだあとの知らせ */
export function importedNotice(done: ErImported[]): string {
  if (done.length === 0) return "取り込んだ図はありません";
  const renamed = done.filter((d) => d.savedAs !== d.name).length;
  return (
    `${done.length}件の図を取り込みました` +
    (renamed > 0 ? ` (同じ名前の${renamed}件は番号を付けて追加)` : "")
  );
}
