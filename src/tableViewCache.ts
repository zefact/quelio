/**
 * 見たテーブルの定義とデータの控え (画面を行き来したときに取り直さないため)。
 *
 * タブの状態 (`WorkTab`) が持てるのは選んでいる1テーブルぶんだけなので、
 * 別のテーブルやSQLエディタへ移るときに、そこまでの内容をここへ預ける。
 * 戻ってきたら預けたものをそのまま出す (ページ・並べ替え・絞り込みも元のまま)。
 *
 * 取り直すのは「再読み込み」を押したときと、テーブル一覧やDBを読み直したとき。
 * 1ページ最大1000行を持つので、覚えておく数には上限を付ける
 */
import type { TabTableData, TableDetail } from "./types";

/** 預けておく中身 */
export interface CachedTableView {
  detail: TableDetail;
  data: TabTableData;
}

/** 覚えておくテーブルの数 (全タブ合わせて。古いものから捨てる) */
export const TABLE_CACHE_LIMIT = 10;

function slot(sessionKey: string, database: string, table: string): string {
  return [sessionKey, database, table].join("\u0000");
}

/** 挿入順 = 使った順 (Mapは入れ直すと末尾へ回る) */
const cache = new Map<string, CachedTableView>();

/** 今のテーブルの内容を預ける (取得中のものは預けない) */
export function stashTableView(
  sessionKey: string,
  database: string,
  table: string,
  view: CachedTableView
): void {
  const key = slot(sessionKey, database, table);
  cache.delete(key);
  // 取得中・失敗したデータは持たない (戻ったときに取り直す)
  const data =
    view.data.loading || view.data.error
      ? { ...view.data, data: null, loading: false, error: null }
      : view.data;
  cache.set(key, { detail: view.detail, data });
  while (cache.size > TABLE_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 預けた内容を取り出す (取り出したものは控えから外す。表示中の1件はタブが持つ) */
export function takeTableView(
  sessionKey: string,
  database: string,
  table: string
): CachedTableView | undefined {
  const key = slot(sessionKey, database, table);
  const hit = cache.get(key);
  cache.delete(key);
  return hit;
}

/** その接続タブのぶんを捨てる (一覧の読み直し・DBの切り替え・タブを閉じたとき) */
export function dropTableViews(sessionKey: string): void {
  const prefix = `${sessionKey}\u0000`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** テストで前の状態を持ち越さないようにする */
export function resetTableViewCache(): void {
  cache.clear();
}
