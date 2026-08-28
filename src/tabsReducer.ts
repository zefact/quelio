/**
 * タブ一覧の状態遷移。
 *
 * 画面の操作はほとんどが「あるタブの一部だけを差し替える」形をしていて、
 * これまでは同じ `setTabs(ts => ts.map(...))` があちこちに散っていた。
 * ここに集めておくと、遷移だけを取り出してテストできる
 * (Reactに依存しない純粋な関数なので、画面を動かさずに確かめられる)
 */
import type {
  EditorOptions,
  QuerySheet,
  TabEditorState,
  TabKvState,
  TabTableData,
  WorkTab,
} from "./types";

export type TabAction =
  /** 一覧ごと入れ替える (前回の作業状態の復元など) */
  | { type: "replace"; tabs: WorkTab[] }
  /** 末尾に足す */
  | { type: "add"; tab: WorkTab }
  /** 1枚閉じる (表示中タブの移動は呼び出し側で行う) */
  | { type: "close"; key: string }
  /** タブ自体の項目を差し替える */
  | { type: "patchTab"; key: string; patch: Partial<WorkTab> }
  /** SQLエディタまわり (実行中かどうか・シートの並び) */
  | { type: "patchEditor"; key: string; patch: Partial<TabEditorState> }
  /** 表示中のシートの中身 (書きかけのSQL・実行結果) */
  | { type: "patchSheet"; key: string; patch: Partial<QuerySheet> }
  /** 表示中のシートの実行設定 (トランザクション等) */
  | { type: "patchEditorOpts"; key: string; patch: Partial<EditorOptions> }
  /** Valkey画面 */
  | { type: "patchKv"; key: string; patch: Partial<TabKvState> }
  /** データタブ */
  | { type: "patchData"; key: string; patch: Partial<TabTableData> }
  /**
   * シートの並びを編集する。
   *
   * 今の内容を見て決める必要がある (しまう・出す) ので関数で受ける。
   * 実行中は結果の行き先が変わってしまうため、何もしない
   */
  | {
      type: "editSheets";
      key: string;
      edit: (editor: TabEditorState) => Partial<TabEditorState> | null;
    };

/** 指定のタブだけを差し替える (他はそのままの参照を返す) */
function patchOne(
  tabs: WorkTab[],
  key: string,
  fn: (tab: WorkTab) => WorkTab
): WorkTab[] {
  return tabs.map((t) => (t.key === key ? fn(t) : t));
}

export function tabsReducer(tabs: WorkTab[], action: TabAction): WorkTab[] {
  switch (action.type) {
    case "replace":
      return action.tabs;

    case "add":
      return [...tabs, action.tab];

    case "close":
      return tabs.filter((t) => t.key !== action.key);

    case "patchTab":
      return patchOne(tabs, action.key, (t) => ({ ...t, ...action.patch }));

    case "patchEditor":
      return patchOne(tabs, action.key, (t) => ({
        ...t,
        editor: { ...t.editor, ...action.patch },
      }));

    case "patchSheet":
      return patchOne(tabs, action.key, (t) => ({
        ...t,
        editor: {
          ...t.editor,
          sheets: t.editor.sheets.map((s) =>
            s.id === t.editor.activeSheet ? { ...s, ...action.patch } : s
          ),
        },
      }));

    case "patchEditorOpts":
      return patchOne(tabs, action.key, (t) => ({
        ...t,
        editor: {
          ...t.editor,
          sheets: t.editor.sheets.map((s) =>
            s.id === t.editor.activeSheet
              ? { ...s, editorOpts: { ...s.editorOpts, ...action.patch } }
              : s
          ),
        },
      }));

    case "patchKv":
      return patchOne(tabs, action.key, (t) => ({
        ...t,
        kv: { ...t.kv, ...action.patch },
      }));

    case "patchData":
      return patchOne(tabs, action.key, (t) => ({
        ...t,
        tableData: { ...t.tableData, ...action.patch },
      }));

    case "editSheets":
      return patchOne(tabs, action.key, (t) => {
        // 実行中はシートを動かさない (結果の行き先が変わってしまう)
        if (t.editor.running) return t;
        const patch = action.edit(t.editor);
        return patch ? { ...t, editor: { ...t.editor, ...patch } } : t;
      });
  }
}
