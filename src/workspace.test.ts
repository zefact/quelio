import { describe, expect, it } from "vitest";
import { MAX_SHEETS, toSaved, toTabs } from "./workspace";
import type { SavedWorkspace } from "./workspace";
import { defaultEditorOptions, emptySheet, emptyTab, newSheetId } from "./types";
import type { ConnectionStore, WorkTab } from "./types";

const store: ConnectionStore = {
  folders: [],
  connections: [
    {
      id: "c1",
      name: "本番",
      dbType: "mysql",
      host: "h",
      port: 3306,
      user: "u",
      password: "",
    },
  ],
};

/** 接続先とシートを持つタブを作る */
function tabWith(sheets: { title: string; sql: string }[], activeAt = 0) {
  const t: WorkTab = emptyTab("k1");
  t.profile = { ...store.connections[0] };
  const list = sheets.map((s) => ({
    ...emptySheet(newSheetId()),
    title: s.title,
    sql: s.sql,
  }));
  t.editor = {
    ...t.editor,
    sheets: list,
    activeSheet: list[activeAt].id,
    // 表示中のシートの内容はエディタ側に置かれている
    sql: list[activeAt].sql,
    editorOpts: list[activeAt].editorOpts,
  };
  return t;
}

let seq = 0;
const newKey = () => `tab-${seq++}`;

describe("toSaved / toTabs", () => {
  it("シートの並び順と表示位置が往復で変わらない", () => {
    const tab = tabWith(
      [
        { title: "検証", sql: "SELECT 1" },
        { title: "本命", sql: "UPDATE t SET a = 1" },
        { title: "", sql: "SELECT 3" },
      ],
      1
    );
    const saved = toSaved([tab], tab.key);
    const built = toTabs(saved, store, newKey);
    expect(built).not.toBeNull();
    const back = built!.tabs[0];
    expect(back.editor.sheets.map((s) => s.sql)).toEqual([
      "SELECT 1",
      "UPDATE t SET a = 1",
      "SELECT 3",
    ]);
    expect(back.editor.sheets.map((s) => s.title)).toEqual(["検証", "本命", ""]);
    // 表示中のシートも同じものに戻る
    const at = back.editor.sheets.findIndex((s) => s.id === back.editor.activeSheet);
    expect(at).toBe(1);
    expect(back.editor.sql).toBe("UPDATE t SET a = 1");
  });

  it("表示中のシートの内容はタブ側から拾う", () => {
    const tab = tabWith([{ title: "", sql: "古い" }]);
    tab.editor.sql = "書きかけ";
    const saved = toSaved([tab], tab.key);
    expect(saved.tabs[0].sheets?.[0].sql).toBe("書きかけ");
  });

  it("実行結果は保存しない", () => {
    const tab = tabWith([{ title: "", sql: "SELECT 1" }]);
    tab.editor.queryError = "エラー";
    const built = toTabs(toSaved([tab], tab.key), store, newKey)!;
    expect(built.tabs[0].editor.queryError).toBeNull();
    expect(built.tabs[0].editor.queryResults).toBeNull();
  });

  it("シートを持たない古い形式 (v1) からも1枚作る", () => {
    const v1: SavedWorkspace = {
      version: 1,
      activeIndex: 0,
      tabs: [
        {
          profileId: "c1",
          sql: "SELECT 1",
          view: "query",
          editorOpts: defaultEditorOptions(),
          tableTab: "definition",
          db: null,
          table: null,
        },
      ],
    };
    const built = toTabs(v1, store, newKey)!;
    expect(built.tabs[0].editor.sheets).toHaveLength(1);
    expect(built.tabs[0].editor.sql).toBe("SELECT 1");
    expect(built.tabs[0].editor.activeSheet).toBe(built.tabs[0].editor.sheets[0].id);
  });

  it("versionが無い保存内容は読まない", () => {
    const broken = { activeIndex: 0, tabs: [] } as unknown as SavedWorkspace;
    expect(toTabs(broken, store, newKey)).toBeNull();
  });

  it("壊れた要素が混ざっていても落ちない", () => {
    const tab = tabWith([{ title: "", sql: "SELECT 1" }]);
    const saved = toSaved([tab], tab.key);
    // 保存ファイルが壊れて null が混ざった状態
    saved.tabs = [null, ...saved.tabs] as unknown as typeof saved.tabs;
    const built = toTabs(saved, store, newKey);
    expect(built).not.toBeNull();
    expect(built!.tabs).toHaveLength(1);
    expect(built!.tabs[0].editor.sql).toBe("SELECT 1");
  });

  it("知らない新しい形式は読まない", () => {
    const future = { version: 99, activeIndex: 0, tabs: [] } as SavedWorkspace;
    expect(toTabs(future, store, newKey)).toBeNull();
  });

  it("消された接続先を指していたら、接続先なしのタブになる", () => {
    const tab = tabWith([{ title: "", sql: "SELECT 1" }]);
    tab.profile = { ...tab.profile, id: "missing" };
    const built = toTabs(toSaved([tab], tab.key), store, newKey)!;
    expect(built.tabs[0].profile.id).not.toBe("missing");
    // 書きかけのSQLは残す
    expect(built.tabs[0].editor.sql).toBe("SELECT 1");
  });

  it("シートは上限までしか保存しない", () => {
    const many = Array.from({ length: MAX_SHEETS + 5 }, (_, i) => ({
      title: "",
      sql: `SELECT ${i}`,
    }));
    const tab = tabWith(many);
    expect(toSaved([tab], tab.key).tabs[0].sheets).toHaveLength(MAX_SHEETS);
  });

  it("表示位置が範囲外でも壊れない", () => {
    const tab = tabWith([{ title: "", sql: "SELECT 1" }]);
    const saved = toSaved([tab], tab.key);
    saved.tabs[0].activeSheet = 99;
    const built = toTabs(saved, store, newKey)!;
    expect(built.tabs[0].editor.activeSheet).toBe(built.tabs[0].editor.sheets[0].id);
  });

  it("接続中のタブは、開いていたDBとテーブルを復元先として持つ", () => {
    const tab = tabWith([{ title: "", sql: "" }]);
    tab.connected = true;
    tab.selectedDb = "app";
    tab.selectedTable = ".users";
    const built = toTabs(toSaved([tab], tab.key), store, newKey)!;
    expect(built.tabs[0].restore).toEqual({
      profileId: "c1",
      db: "app",
      table: ".users",
    });
  });
});
