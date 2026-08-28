import { describe, expect, it } from "vitest";
import { tabsReducer } from "./tabsReducer";
import { activeSheetOf, emptyTab } from "./types";
import type { WorkTab } from "./types";

function two(): WorkTab[] {
  return [emptyTab("a"), emptyTab("b")];
}

describe("tabsReducer", () => {
  it("指定のタブだけを差し替える", () => {
    const tabs = two();
    const next = tabsReducer(tabs, {
      type: "patchTab",
      key: "a",
      patch: { connected: true },
    });
    expect(next[0].connected).toBe(true);
    // 触っていないタブは同じ参照のまま (無駄な再描画を増やさない)
    expect(next[1]).toBe(tabs[1]);
  });

  it("書きかけのSQLは表示中のシートに入る", () => {
    const next = tabsReducer(two(), {
      type: "patchSheet",
      key: "b",
      patch: { sql: "SELECT 1" },
    });
    expect(activeSheetOf(next[1].editor).sql).toBe("SELECT 1");
    // シートの枚数や表示中の指定は変わらない
    expect(next[1].editor.sheets).toHaveLength(1);
    expect(next[1].editor.activeSheet).toBe(next[1].editor.sheets[0].id);
  });

  it("表示していないシートは書き換えない", () => {
    const two2 = tabsReducer(two(), {
      type: "editSheets",
      key: "a",
      edit: (e) => ({
        sheets: [...e.sheets, { ...e.sheets[0], id: "other", sql: "別" }],
      }),
    });
    const next = tabsReducer(two2, {
      type: "patchSheet",
      key: "a",
      patch: { sql: "表示中" },
    });
    expect(activeSheetOf(next[0].editor).sql).toBe("表示中");
    expect(next[0].editor.sheets[1].sql).toBe("別");
  });

  it("実行設定だけを差し替えても他の設定は残る", () => {
    const on = tabsReducer(two(), {
      type: "patchEditorOpts",
      key: "a",
      patch: { txn: true },
    });
    const next = tabsReducer(on, {
      type: "patchEditorOpts",
      key: "a",
      patch: { capture: true },
    });
    const opts = activeSheetOf(next[0].editor).editorOpts;
    expect(opts.txn).toBe(true);
    expect(opts.capture).toBe(true);
    // 触っていない設定はそのまま
    expect(opts.runMode).toBe("all");
  });

  it("データタブとValkeyの状態も入れ子で差し替える", () => {
    const next = tabsReducer(
      tabsReducer(two(), {
        type: "patchData",
        key: "a",
        patch: { where: "id = 1" },
      }),
      { type: "patchKv", key: "a", patch: { execError: "エラー" } }
    );
    expect(next[0].tableData.where).toBe("id = 1");
    expect(next[0].kv.execError).toBe("エラー");
  });

  it("知らないキーへの指定は何も変えない", () => {
    const tabs = two();
    const next = tabsReducer(tabs, {
      type: "patchTab",
      key: "none",
      patch: { connected: true },
    });
    expect(next).toEqual(tabs);
  });

  it("追加・削除・入れ替え", () => {
    const added = tabsReducer(two(), { type: "add", tab: emptyTab("c") });
    expect(added.map((t) => t.key)).toEqual(["a", "b", "c"]);
    const closed = tabsReducer(added, { type: "close", key: "b" });
    expect(closed.map((t) => t.key)).toEqual(["a", "c"]);
    const replaced = tabsReducer(closed, {
      type: "replace",
      tabs: [emptyTab("z")],
    });
    expect(replaced.map((t) => t.key)).toEqual(["z"]);
  });

  describe("editSheets", () => {
    it("今の内容を見て差し替えられる", () => {
      const next = tabsReducer(two(), {
        type: "editSheets",
        key: "a",
        edit: (e) => ({ activeSheet: e.sheets[0].id }),
      });
      expect(next[0].editor.activeSheet).toBe(next[0].editor.sheets[0].id);
    });

    it("nullを返したら何もしない", () => {
      const tabs = two();
      const next = tabsReducer(tabs, {
        type: "editSheets",
        key: "a",
        edit: () => null,
      });
      expect(next[0]).toBe(tabs[0]);
    });

    it("実行中は動かさない", () => {
      const running = tabsReducer(two(), {
        type: "patchEditor",
        key: "a",
        patch: { running: true },
      });
      const next = tabsReducer(running, {
        type: "editSheets",
        key: "a",
        edit: () => ({ sheets: [] }),
      });
      expect(next[0]).toBe(running[0]);
    });
  });
});
