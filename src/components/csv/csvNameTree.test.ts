/**
 * 列名のお気に入りも、固定長と同じ計算でフォルダ分け・並べ替え・バックアップの選び方ができるか
 */
import { describe, expect, it } from "vitest";
import type { CsvNameNode, CsvNameSet } from "../../types";
import {
  backupFileName,
  exportPick,
  importedNotice,
  layoutBackupFileName,
  pickAll,
} from "./csvLayoutPick";
import {
  addFolder,
  applyMove,
  flatLayouts,
  removeFolder,
  rowsOf,
} from "./csvLayoutTree";

const set = (name: string, columns: string[]): CsvNameSet => ({
  name,
  columns,
  updatedAtMs: 1,
});

const nodes: CsvNameNode[] = [
  { kind: "item", ...set("売上", ["日付", "", "金額"]) },
  { kind: "folder", name: "月次", items: [set("顧客", ["ID", "氏名"])] },
];

describe("列名のお気に入りの並べ替え", () => {
  it("動かしても中身 (列名) はそのまま残り、節の印は付かない", () => {
    const moved = applyMove(
      nodes,
      { type: "item", name: "売上" },
      { folder: "月次", index: 1 }
    );
    expect(moved).toHaveLength(1);
    const folder = moved[0];
    if (folder.kind !== "folder") throw new Error("フォルダのまま");
    expect(folder.items.map((s) => s.name)).toEqual(["顧客", "売上"]);
    // フォルダに入れたものは、一番上の並びの印 (kind) を持たない
    expect(folder.items[1]).toEqual(set("売上", ["日付", "", "金額"]));
  });

  it("フォルダを外すと中身が一番上の並びに戻る", () => {
    const out = removeFolder(nodes, "月次");
    expect(out).toEqual([
      { kind: "item", ...set("売上", ["日付", "", "金額"]) },
      { kind: "item", ...set("顧客", ["ID", "氏名"]) },
    ]);
  });

  it("行の並びと平らな並びが作れる", () => {
    const withFolder = addFolder(nodes, "新しいフォルダ");
    expect(rowsOf(withFolder).map((r) => (r.type === "folder" ? `f:${r.name}` : r.saved.name))).toEqual([
      "売上",
      "f:月次",
      "顧客",
      "f:新しいフォルダ",
    ]);
    expect(flatLayouts(nodes).map((s) => s.columns.length)).toEqual([3, 2]);
  });
});

describe("列名のお気に入りのバックアップ", () => {
  it("全部選んで書き出すものを決められる", () => {
    expect(exportPick(pickAll(nodes))).toEqual({ names: ["売上", "顧客"], folders: [] });
  });

  it("既定のファイル名は種類ごとの頭に日付を付ける", () => {
    const d = new Date(2026, 10, 18);
    expect(backupFileName("quelio_csv_names", d)).toBe("quelio_csv_names_20261118.json");
    // 固定長は今までと同じ名前
    expect(layoutBackupFileName(d)).toBe("quelio_csv_layouts_20261118.json");
  });

  it("取り込んだあとの知らせに種類の呼び名を入れる", () => {
    expect(
      importedNotice("列名のお気に入り", [
        { name: "売上", savedAs: "売上 (2)" },
        { name: "顧客", savedAs: "顧客" },
      ])
    ).toBe("列名のお気に入りを2件追加しました (同じ名前の1件は番号を付けて追加)");
  });
});
