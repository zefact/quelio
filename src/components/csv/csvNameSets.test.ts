import { describe, expect, it } from "vitest";
import type { CsvInfo, CsvNameSet } from "../../types";
import { appliedNameSet, applyBlocked, namePreview, saveBlocked } from "./csvNameSets";

const set = (name: string, columns: string[]): CsvNameSet => ({ name, columns, updatedAtMs: 0 });

const info = (over: Partial<CsvInfo>): CsvInfo =>
  ({
    format: { fixed: null },
    hasHeader: false,
    labels: [],
    ...over,
  }) as CsvInfo;

describe("appliedNameSet", () => {
  const sets = [set("売上", ["日付", "", "金額"]), set("顧客", ["ID", "名前"])];

  it("今の列名と同じお気に入りを見つける (足りない所は名前なし扱い)", () => {
    expect(appliedNameSet(sets, ["日付", "", "金額"])).toBe("売上");
    expect(appliedNameSet(sets, ["ID", "名前", ""])).toBe("顧客");
  });

  it("違えば無し。名前を1つも付けていなければ無し", () => {
    expect(appliedNameSet(sets, ["日付", "店", "金額"])).toBeNull();
    expect(appliedNameSet(sets, ["", "", ""])).toBeNull();
  });
});

describe("namePreview", () => {
  it("先頭のいくつかと残りの数。名前の無い列は番号", () => {
    expect(namePreview(["日付", "", "金額"])).toBe("日付, 2, 金額");
    expect(namePreview(["a", "b", "c", "d", "e"])).toBe("a, b, c ほか2列");
  });
});

describe("使えるかの判断", () => {
  it("見出しの無いCSVにだけ当てられる", () => {
    expect(applyBlocked(info({}))).toBeNull();
    expect(applyBlocked(info({ hasHeader: true }))).not.toBeNull();
    expect(applyBlocked(info({ format: { fixed: {} } as CsvInfo["format"] }))).not.toBeNull();
    expect(applyBlocked(null)).not.toBeNull();
  });

  it("名前を付けていれば保存できる。見出しのあるCSVは見出しを保存できる", () => {
    expect(saveBlocked(info({ labels: ["", "金額"] }))).toBeNull();
    expect(saveBlocked(info({ labels: ["", ""] }))).not.toBeNull();
    expect(saveBlocked(info({ hasHeader: true }))).toBeNull();
  });
});
