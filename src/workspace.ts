/**
 * 作業状態 (開いていたタブ・書きかけのSQL) の保存と復元。
 *
 * 保存するのは「次に開いたときに戻したいもの」だけ。
 * 取得済みのテーブル一覧や実行結果は保存せず、接続し直したときに取り直す。
 */
import { getWorkspace, saveWorkspace } from "./api";
import type { ConnectionStore, EditorOptions, TableTab, WorkTab } from "./types";
import {
  defaultEditorOptions,
  emptyProfile,
  emptySheet,
  emptyTab,
  newSheetId,
} from "./types";

/** 保存形式のバージョン (合わないものは読み捨てる) */
const VERSION = 2;

/** 1タブで持てるシートの上限 (画面側の「＋」もこれで止める) */
export const MAX_SHEETS = 20;

/** 復元できるタブの上限 (壊れたファイルでタブが増え続けないように) */
const MAX_TABS = 20;

/** シート1枚ぶんの保存内容 (実行結果は保存しない) */
export interface SavedSheet {
  title: string;
  sql: string;
  editorOpts: EditorOptions;
}

/** 1タブぶんの保存内容 */
export interface SavedTab {
  /** 接続先のID (未選択なら空文字) */
  profileId: string;
  sql: string;
  view: "structure" | "query";
  editorOpts: EditorOptions;
  /** 書きかけのSQLのシート (並び順はそのまま) */
  sheets?: SavedSheet[];
  /** 表示していたシートの位置 */
  activeSheet?: number;
  /** 表示していたタブ (定義 / データ) */
  tableTab: TableTab;
  /** 接続し直したときに戻す先 */
  db: string | null;
  table: string | null;
}

export interface SavedWorkspace {
  version: number;
  tabs: SavedTab[];
  /** 前面だったタブの位置 */
  activeIndex: number;
}

/** 現在のタブから保存内容を作る */
export function toSaved(tabs: WorkTab[], activeKey: string): SavedWorkspace {
  return {
    version: VERSION,
    // 上限で切ったあとの位置で持つ (復元時にずれないように)
    activeIndex: Math.max(
      0,
      tabs.slice(0, MAX_TABS).findIndex((t) => t.key === activeKey)
    ),
    tabs: tabs.slice(0, MAX_TABS).map((t) => ({
      profileId: t.profile.id,
      sql: t.editor.sql,
      view: t.view,
      editorOpts: t.editor.editorOpts,
      // 並び順はそのまま。表示中のぶんだけタブ側の内容で置き換える
      // (実行結果は保存しない)
      sheets: t.editor.sheets.slice(0, MAX_SHEETS).map((s) =>
        s.id === t.editor.activeSheet
          ? { title: s.title, sql: t.editor.sql, editorOpts: t.editor.editorOpts }
          : { title: s.title, sql: s.sql, editorOpts: s.editorOpts }
      ),
      activeSheet: Math.max(
        0,
        t.editor.sheets
          .slice(0, MAX_SHEETS)
          .findIndex((s) => s.id === t.editor.activeSheet)
      ),
      tableTab: t.tableTab,
      // 未接続のタブは、前回の復元先をそのまま持ち越す
      db: t.connected ? t.selectedDb : (t.restore?.db ?? null),
      table: t.connected ? t.selectedTable : (t.restore?.table ?? null),
    })),
  };
}

/** 保存内容からタブを組み立てる (接続はしない) */
export function toTabs(
  saved: SavedWorkspace,
  store: ConnectionStore,
  newKey: () => string
): { tabs: WorkTab[]; activeKey: string } | null {
  // 古い形式 (シートを持たない v1) も読む。sheets が無ければ1枚だけ作る
  if (
    typeof saved.version !== "number" ||
    saved.version > VERSION ||
    saved.version < 1 ||
    !Array.isArray(saved.tabs)
  ) {
    return null;
  }
  const byId = new Map(store.connections.map((c) => [c.id, c]));
  const tabs = saved.tabs
    // 壊れた要素 (null など) が混ざっていても、読めるところまでは読む
    .filter((s) => s && typeof s === "object")
    .slice(0, MAX_TABS)
    .map((s) => {
      const tab = emptyTab(newKey());
      // 消された接続先を指していた場合は、接続先なしのタブとして開く
      const profile = s.profileId ? byId.get(s.profileId) : undefined;
      tab.profile = profile ? structuredClone(profile) : emptyProfile();
      const sql = typeof s.sql === "string" ? s.sql : "";
      const editorOpts = { ...defaultEditorOptions(), ...(s.editorOpts ?? {}) };
      tab.view = s.view === "query" ? "query" : "structure";
      // シート (無い場合は古い形式なので sql / editorOpts から1枚だけ作る)
      const saved =
        Array.isArray(s.sheets) && s.sheets.length > 0
          ? s.sheets.slice(0, MAX_SHEETS)
          : [{ title: "", sql, editorOpts }];
      const sheets = saved.map((sh) => ({
        ...emptySheet(newSheetId()),
        title: typeof sh.title === "string" ? sh.title : "",
        sql: typeof sh.sql === "string" ? sh.sql : "",
        editorOpts: { ...defaultEditorOptions(), ...(sh.editorOpts ?? {}) },
      }));
      const at = Math.min(
        Math.max(0, typeof s.activeSheet === "number" ? s.activeSheet : 0),
        sheets.length - 1
      );
      // 表示中のぶんは、シートの内容をそのまま出す
      tab.editor = {
        ...tab.editor,
        sheets,
        activeSheet: sheets[at].id,
        sql: sheets[at].sql,
        editorOpts: sheets[at].editorOpts,
      };
      tab.tableTab = s.tableTab === "data" ? "data" : "definition";
      // 接続し直したときに戻す先 (接続先が残っている場合のみ)
      if (profile && (s.db || s.table)) {
        tab.restore = {
          profileId: profile.id,
          db: s.db ?? null,
          table: s.table ?? null,
        };
      }
      return tab;
    });
  if (tabs.length === 0) return null;
  const active = tabs[Math.min(Math.max(0, saved.activeIndex), tabs.length - 1)];
  return { tabs, activeKey: active.key };
}

/**
 * 前回の作業状態を読み込む。
 *
 * 読めたかどうかを分けて返す。読めなかったときに「無かった」と扱うと、
 * 空の状態で上書き保存して書きかけのSQLを失うため
 */
export async function loadWorkspace(): Promise<
  { ok: true; data: SavedWorkspace | null } | { ok: false }
> {
  try {
    return { ok: true, data: (await getWorkspace()) as SavedWorkspace | null };
  } catch {
    return { ok: false };
  }
}

/** 作業状態を保存する。書けたら true (失敗しても画面には出さない) */
export async function storeWorkspace(data: SavedWorkspace): Promise<boolean> {
  try {
    await saveWorkspace(data);
    return true;
  } catch {
    return false;
  }
}
