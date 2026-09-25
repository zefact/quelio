import { describe, expect, it } from "vitest";
import {
  entryMeta,
  erBackupFileName,
  importedNotice,
  toggleName,
} from "./erTransfer";

describe("ER図のバックアップ・復元", () => {
  it("ファイル名に日付を入れる", () => {
    expect(erBackupFileName(new Date(2026, 8, 4))).toBe(
      "quelio_er_diagrams_20260904.json"
    );
  });

  it("印を付け外しする (元のSetは変えない)", () => {
    const a = new Set(["x"]);
    const b = toggleName(a, "y");
    expect([...b].sort()).toEqual(["x", "y"]);
    expect(toggleName(b, "x").has("x")).toBe(false);
    expect(a.has("y")).toBe(false);
  });

  it("ページが1つならテーブル数だけを出す", () => {
    expect(entryMeta({ name: "a", saveAs: "a", pages: 1, tables: 5 })).toBe("5テーブル");
    expect(entryMeta({ name: "a", saveAs: "a", pages: 3, tables: 12 })).toBe(
      "3ページ・12テーブル"
    );
  });

  it("番号を付けて足した数も知らせる", () => {
    expect(importedNotice([])).toBe("取り込んだ図はありません");
    expect(
      importedNotice([
        { name: "a", savedAs: "a" },
        { name: "b", savedAs: "b (2)" },
      ])
    ).toBe("2件の図を取り込みました (同じ名前の1件は番号を付けて追加)");
  });
});
