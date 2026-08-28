/**
 * 書きかけSQL (シート) の保存と復元。
 *
 * 保存するのは「次に開いたときに戻したいもの」だけ。
 * 接続タブは毎回まっさらから始めるので保存しない。
 * 取得済みのテーブル一覧や実行結果も保存せず、接続し直したときに取り直す。
 *
 * シートは接続タブをまたいで1列にまとめて持つ。
 * 「どの接続で書いたか」は戻さないが、書いたSQLは1枚も落とさないため
 */
import { getWorkspace, saveWorkspace } from "./api";
import type { EditorOptions, WorkTab } from "./types";
import {
  defaultEditorOptions,
  emptySheet,
  emptyTab,
  newSheetId,
} from "./types";

/** 保存形式のバージョン (合わないものは読み捨てる) */
const VERSION = 3;

/** 1タブで持てるシートの上限 (画面側の「＋」もこれで止める) */
export const MAX_SHEETS = 20;

/** シート1枚ぶんの保存内容 (実行結果は保存しない) */
export interface SavedSheet {
  title: string;
  sql: string;
  editorOpts: EditorOptions;
}

export interface SavedWorkspace {
  version: number;
  /** 全タブぶんのシートを、並び順そのままで1列にしたもの */
  sheets: SavedSheet[];
  /** 前面だったシートの位置 */
  activeSheet: number;
}

/** 中身のあるシートだけ残す (名前もSQLも無いものは保存しない) */
function hasContent(s: { title: string; sql: string }): boolean {
  return s.title.trim() !== "" || s.sql.trim() !== "";
}

/** 現在のタブから保存内容を作る */
export function toSaved(tabs: WorkTab[], activeKey: string): SavedWorkspace {
  const all = tabs.flatMap((t) =>
    t.editor.sheets.map((s) => ({
      sheet: s,
      // 前面のタブで開いていたシートかどうか (戻したときの表示位置に使う)
      front: t.key === activeKey && s.id === t.editor.activeSheet,
    }))
  );
  const kept = all.filter((x) => hasContent(x.sheet)).slice(0, MAX_SHEETS);
  return {
    version: VERSION,
    sheets: kept.map(({ sheet }) => ({
      title: sheet.title,
      sql: sheet.sql,
      editorOpts: sheet.editorOpts,
    })),
    // 上限で切られて見つからない場合は先頭に戻す
    activeSheet: Math.max(
      0,
      kept.findIndex((x) => x.front)
    ),
  };
}

/** 保存内容のどれか1枚を、形の崩れに強く読む */
function readSheet(v: unknown): SavedSheet | null {
  if (!v || typeof v !== "object") return null;
  const s = v as { title?: unknown; sql?: unknown; editorOpts?: unknown };
  const sheet = {
    title: typeof s.title === "string" ? s.title : "",
    sql: typeof s.sql === "string" ? s.sql : "",
    editorOpts: {
      ...defaultEditorOptions(),
      ...(s.editorOpts && typeof s.editorOpts === "object" ? s.editorOpts : {}),
    },
  };
  return hasContent(sheet) ? sheet : null;
}

/**
 * 保存内容からシートの並びを取り出す。
 *
 * 読むのは今の形式だけ。タブごとに持っていた古い形式 (v1 / v2) は
 * 読み捨てる (戻すのは接続タブではなくSQLだけになったため)
 */
export function toSheets(
  saved: SavedWorkspace
): { sheets: SavedSheet[]; activeSheet: number } | null {
  if (!saved || saved.version !== VERSION || !Array.isArray(saved.sheets)) {
    return null;
  }
  const at = typeof saved.activeSheet === "number" ? saved.activeSheet : 0;
  // 中身の無いシートは落とすので、表示位置もその並びで数え直す
  let active = 0;
  const sheets: SavedSheet[] = [];
  saved.sheets.forEach((v, i) => {
    if (sheets.length >= MAX_SHEETS) return;
    const s = readSheet(v);
    if (!s) return;
    if (i <= at) active = sheets.length;
    sheets.push(s);
  });
  if (sheets.length === 0) return null;
  return { sheets, activeSheet: active };
}

/**
 * 保存内容から、書きかけSQLだけを載せたタブを1つ作る (接続はしない)。
 * 戻すものが無ければ null
 */
export function toTab(saved: SavedWorkspace, key: string): WorkTab | null {
  const restored = toSheets(saved);
  if (!restored) return null;
  const tab = emptyTab(key);
  const sheets = restored.sheets.map((s) => ({
    ...emptySheet(newSheetId()),
    title: s.title,
    sql: s.sql,
    editorOpts: s.editorOpts,
  }));
  tab.editor = {
    ...tab.editor,
    sheets,
    activeSheet: sheets[restored.activeSheet].id,
  };
  // 戻したSQLがすぐ見えるよう、接続したらSQLエディタから始める
  tab.view = "query";
  return tab;
}

/**
 * 前回の書きかけSQLを読み込む。
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

/** 書きかけSQLを保存する。書けたら true (失敗しても画面には出さない) */
export async function storeWorkspace(data: SavedWorkspace): Promise<boolean> {
  try {
    await saveWorkspace(data);
    return true;
  } catch {
    return false;
  }
}
