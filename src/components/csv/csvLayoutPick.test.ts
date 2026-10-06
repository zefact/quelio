import { describe, expect, it } from "vitest";
import {
  exportPick,
  folderPick,
  layoutBackupFileName,
  layoutImportedNotice,
  pickAll,
  pickedCount,
  restoreGroups,
  toggleFolderPick,
  togglePick,
} from "./csvLayoutPick";
import type { CsvFixedLayout, CsvLayoutNode, CsvSavedLayout } from "../../types";

const layout = {} as CsvFixedLayout;
const saved = (name: string): CsvSavedLayout => ({ name, layout, updatedAtMs: 0 });
const folder = (name: string, items: string[]): CsvLayoutNode => ({
  kind: "folder",
  name,
  items: items.map(saved),
});
const item = (name: string): CsvLayoutNode => ({ kind: "item", ...saved(name) });

const nodes = [item("あ"), folder("受注", ["い", "う"]), folder("空", [])];

describe("固定長のお気に入りの選び方", () => {
  it("開いたときは全部選ぶ (中身の無いフォルダも)", () => {
    expect([...pickAll(nodes)].sort()).toEqual(["f:空", "i:あ", "i:い", "i:う"]);
    expect(pickedCount(pickAll(nodes))).toBe(3);
  });

  it("フォルダの印は中身から決まり、押すと全部付く・全部外れる", () => {
    const one = new Set(["i:い"]);
    expect(folderPick(nodes[1], one)).toBe("some");
    const all = toggleFolderPick(nodes[1], one);
    expect(folderPick(nodes[1], all)).toBe("all");
    expect(folderPick(nodes[1], toggleFolderPick(nodes[1], all))).toBe("none");
    // 中身の無いフォルダは、フォルダそのものを選ぶ
    expect(folderPick(nodes[2], toggleFolderPick(nodes[2], new Set()))).toBe("all");
  });

  it("書き出すものを名前とフォルダに分ける", () => {
    const sel = togglePick(pickAll(nodes), "i:あ");
    const plan = exportPick(sel);
    expect(plan.names.sort()).toEqual(["い", "う"]);
    expect(plan.folders).toEqual(["空"]);
  });

  it("ファイル名に日付を入れる", () => {
    expect(layoutBackupFileName(new Date(2026, 9, 5))).toBe(
      "quelio_csv_layouts_20261005.json"
    );
  });
});

describe("固定長のお気に入りの復元", () => {
  const e = (
    name: string,
    folder: string | null,
    saveAs = name,
    saveFolder = folder
  ) => ({ name, folder, saveAs, saveFolder, columns: 3 });

  it("取り込み先のフォルダごとにまとめ、名前が変わるフォルダは元の名前を持つ", () => {
    const groups = restoreGroups([
      e("あ", null),
      e("い", "受注", "い (2)", "受注 (2)"),
      e("う", "受注", "う", "受注 (2)"),
      e("え", null),
      e("お", "出荷"),
    ]);
    expect(groups.map((g) => [g.folder, g.renamedFrom, g.entries.length])).toEqual([
      [null, null, 1],
      ["受注 (2)", "受注", 2],
      [null, null, 1],
      ["出荷", null, 1],
    ]);
  });

  it("番号を付けて足した数も知らせる", () => {
    expect(layoutImportedNotice([])).toBe("取り込んだお気に入りはありません");
    expect(
      layoutImportedNotice([
        { name: "あ", savedAs: "あ" },
        { name: "い", savedAs: "い (2)" },
      ])
    ).toBe("固定長のお気に入りを2件取り込みました (同じ名前の1件は番号を付けて追加)");
  });
});
