import { describe, expect, it } from "vitest";
import { MAX_SHEETS, toSaved, toSheets, toTab } from "./workspace";
import type { SavedWorkspace } from "./workspace";
import {
  activeSheetOf,
  defaultEditorOptions,
  emptySheet,
  emptyTab,
  newSheetId,
} from "./types";
import type { WorkTab } from "./types";

/** シートを持つタブを作る */
function tabWith(
  key: string,
  sheets: { title: string; sql: string }[],
  activeAt = 0
): WorkTab {
  const t = emptyTab(key);
  const list = sheets.map((s) => ({
    ...emptySheet(newSheetId()),
    title: s.title,
    sql: s.sql,
  }));
  t.editor = { ...t.editor, sheets: list, activeSheet: list[activeAt].id };
  return t;
}

let seq = 0;
const newKey = () => `tab-${seq++}`;

describe("toSaved", () => {
  it("並び順そのままで、名前とSQLを保存する", () => {
    const tab = tabWith("k1", [
      { title: "検証", sql: "SELECT 1" },
      { title: "本命", sql: "UPDATE t SET a = 1" },
      { title: "", sql: "SELECT 3" },
    ]);
    const saved = toSaved([tab], tab.key);
    expect(saved.sheets.map((s) => s.sql)).toEqual([
      "SELECT 1",
      "UPDATE t SET a = 1",
      "SELECT 3",
    ]);
    expect(saved.sheets.map((s) => s.title)).toEqual(["検証", "本命", ""]);
  });

  it("接続タブが複数あっても、シートは1列にまとめる", () => {
    const a = tabWith("k1", [{ title: "A", sql: "SELECT 1" }]);
    const b = tabWith("k2", [
      { title: "B1", sql: "SELECT 2" },
      { title: "B2", sql: "SELECT 3" },
    ]);
    const saved = toSaved([a, b], "k2");
    expect(saved.sheets.map((s) => s.title)).toEqual(["A", "B1", "B2"]);
    // 前面のタブで開いていたシートの位置になる
    expect(saved.activeSheet).toBe(1);
  });

  it("名前もSQLも無いシートは保存しない", () => {
    const tab = tabWith("k1", [
      { title: "", sql: "   " },
      { title: "", sql: "SELECT 1" },
      { title: "メモ", sql: "" },
    ]);
    const saved = toSaved([tab], tab.key);
    expect(saved.sheets.map((s) => s.title)).toEqual(["", "メモ"]);
  });

  it("空のシートを開いていたら、表示位置は先頭に戻す", () => {
    const tab = tabWith("k1", [{ title: "A", sql: "SELECT 1" }, { title: "", sql: "" }], 1);
    expect(toSaved([tab], tab.key).activeSheet).toBe(0);
  });

  it("シートは上限までしか保存しない", () => {
    const many = Array.from({ length: MAX_SHEETS + 5 }, (_, i) => ({
      title: "",
      sql: `SELECT ${i}`,
    }));
    expect(toSaved([tabWith("k1", many)], "k1").sheets).toHaveLength(MAX_SHEETS);
  });

  it("接続先や開いていたテーブルは保存しない", () => {
    const tab = tabWith("k1", [{ title: "", sql: "SELECT 1" }]);
    tab.connected = true;
    tab.selectedDb = "app";
    tab.selectedTable = ".users";
    const saved = toSaved([tab], tab.key) as unknown as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual([
      "activeSheet",
      "sheets",
      "version",
    ]);
  });
});

describe("toTab", () => {
  it("往復してもシートの並びと表示位置が変わらない", () => {
    const tab = tabWith(
      "k1",
      [
        { title: "検証", sql: "SELECT 1" },
        { title: "本命", sql: "UPDATE t SET a = 1" },
      ],
      1
    );
    const back = toTab(toSaved([tab], tab.key), newKey())!;
    expect(back.editor.sheets.map((s) => s.title)).toEqual(["検証", "本命"]);
    expect(activeSheetOf(back.editor).sql).toBe("UPDATE t SET a = 1");
  });

  it("実行結果は保存しない", () => {
    const tab = tabWith("k1", [{ title: "", sql: "SELECT 1" }]);
    activeSheetOf(tab.editor).queryError = "エラー";
    const sheet = activeSheetOf(toTab(toSaved([tab], tab.key), newKey())!.editor);
    expect(sheet.queryError).toBeNull();
    expect(sheet.queryResults).toBeNull();
  });

  it("戻したタブは接続していない (接続先も空)", () => {
    const tab = tabWith("k1", [{ title: "", sql: "SELECT 1" }]);
    const back = toTab(toSaved([tab], tab.key), newKey())!;
    expect(back.connected).toBe(false);
    expect(back.profile.id).toBe("");
    expect(back.restore).toBeUndefined();
    // 繋いだらSQLエディタから始める
    expect(back.view).toBe("query");
  });

  it("戻すものが無ければ null", () => {
    const empty = toSaved([tabWith("k1", [{ title: "", sql: "" }])], "k1");
    expect(toTab(empty, newKey())).toBeNull();
  });
});

describe("保存内容の読み込み", () => {
  it("タブごとに持っていた古い形式 (v1 / v2) は読まない", () => {
    const v2 = {
      version: 2,
      activeIndex: 0,
      tabs: [
        {
          profileId: "c1",
          sql: "SELECT 1",
          view: "query",
          editorOpts: defaultEditorOptions(),
          sheets: [
            { title: "A", sql: "SELECT 1", editorOpts: defaultEditorOptions() },
          ],
          activeSheet: 0,
          tableTab: "definition",
          db: null,
          table: null,
        },
      ],
    } as unknown as SavedWorkspace;
    expect(toSheets(v2)).toBeNull();
  });

  it("versionが無い / 知らない新しい形式も読まない", () => {
    expect(toSheets({ sheets: [] } as unknown as SavedWorkspace)).toBeNull();
    expect(
      toSheets({ version: 99, sheets: [], activeSheet: 0 } as SavedWorkspace)
    ).toBeNull();
  });

  it("壊れた要素が混ざっていても、読めるところまで読む", () => {
    const broken = {
      version: 3,
      activeSheet: 0,
      sheets: [null, { title: "A", sql: "SELECT 1" }, 5],
    } as unknown as SavedWorkspace;
    const r = toSheets(broken)!;
    expect(r.sheets.map((s) => s.sql)).toEqual(["SELECT 1"]);
    // 既定のエディタ設定で埋める
    expect(r.sheets[0].editorOpts).toEqual(defaultEditorOptions());
  });

  it("表示位置が範囲外でも壊れない", () => {
    const saved: SavedWorkspace = {
      version: 3,
      activeSheet: 99,
      sheets: [{ title: "A", sql: "SELECT 1", editorOpts: defaultEditorOptions() }],
    };
    const back = toTab(saved, newKey())!;
    expect(back.editor.activeSheet).toBe(back.editor.sheets[0].id);
  });
});
