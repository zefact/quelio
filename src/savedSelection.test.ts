import { describe, expect, it } from "vitest";
import {
  backupFileName,
  emptyFolders,
  exportPlan,
  folderCheck,
  restoreFolderName,
  selectAll,
  selectedItemCount,
  toggleFolder,
  toggleItem,
} from "./savedSelection";
import type { SavedSqlEntry, SavedSqlStore } from "./types";

function item(id: string, folder: string): SavedSqlEntry {
  return { id, name: id, folder, sql: "SELECT 1", updatedAtMs: 0 };
}

/** 集計 (a, b) / 集計/月次 (c) / 空 / 空/下 と、ルートの d */
function store(): SavedSqlStore {
  return {
    folders: ["集計", "集計/月次", "空", "空/下"],
    items: [item("a", "集計"), item("b", "集計"), item("c", "集計/月次"), item("d", "")],
    order: [],
  };
}

describe("emptyFolders", () => {
  it("下の階層まで見て、お気に入りが無いフォルダだけを返す", () => {
    expect(emptyFolders(store())).toEqual(["空", "空/下"]);
  });
});

describe("selectAll", () => {
  it("項目と、中身の無いフォルダをすべて選ぶ", () => {
    const sel = selectAll(store());
    expect(selectedItemCount(sel)).toBe(4);
    expect(sel.has("f:空")).toBe(true);
    // 中身のあるフォルダ自体は持たない
    expect(sel.has("f:集計")).toBe(false);
  });
});

describe("folderCheck / toggleFolder", () => {
  it("フォルダを外すと、下の階層ごと外れる", () => {
    const s = store();
    const sel = toggleFolder(s, selectAll(s), "集計");
    expect(folderCheck(s, sel, "集計")).toBe("none");
    expect(folderCheck(s, sel, "集計/月次")).toBe("none");
    expect(sel.has("i:d")).toBe(true);
  });

  it("一部だけ選んでいると「一部」になり、押すと全部選ぶ", () => {
    const s = store();
    let sel = toggleItem(selectAll(s), "c");
    expect(folderCheck(s, sel, "集計")).toBe("some");
    sel = toggleFolder(s, sel, "集計");
    expect(folderCheck(s, sel, "集計")).toBe("all");
  });

  it("中身の無いフォルダも印を付け外しできる", () => {
    const s = store();
    const sel = toggleFolder(s, selectAll(s), "空");
    expect(folderCheck(s, sel, "空")).toBe("none");
    expect(sel.has("f:空/下")).toBe(false);
  });
});

describe("exportPlan", () => {
  it("項目のIDと、中身の無いフォルダのパスに分ける", () => {
    const plan = exportPlan(new Set(["i:a", "f:空"]));
    expect(plan).toEqual({ ids: ["a"], folders: ["空"] });
  });
});

describe("名前の既定", () => {
  const d = new Date(2026, 8, 4);
  it("バックアップのファイル名は日付入り", () => {
    expect(backupFileName(d)).toBe("quelio_saved_sql_20260904.json");
  });
  it("復元先のフォルダ名も日付入り", () => {
    expect(restoreFolderName(d)).toBe("復元 2026-09-04");
  });
});
