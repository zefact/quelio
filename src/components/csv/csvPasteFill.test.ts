import { describe, expect, it } from "vitest";
import { fillPatches, pasteAnchor, singleValue } from "./csvPasteFill";
import type { CsvRange } from "./csvSelection";

function range(top: number, left: number, bottom: number, right: number): CsvRange {
  return { top, left, bottom, right };
}

describe("値1つかどうか", () => {
  it("ふつうの値はそのまま返す", () => {
    expect(singleValue("abc")).toBe("abc");
    expect(singleValue("")).toBe("");
  });

  it("末尾の改行1つは付いていないものとして扱う", () => {
    expect(singleValue("abc\n")).toBe("abc");
    expect(singleValue("abc\r\n")).toBe("abc");
  });

  it("タブや途中の改行があれば表とみなす", () => {
    expect(singleValue("a\tb")).toBeNull();
    expect(singleValue("a\nb")).toBeNull();
    expect(singleValue("a\n\n")).toBeNull();
  });
});

describe("範囲を同じ値で埋める", () => {
  it("四角の中を全部出す", () => {
    const got = fillPatches([range(1, 2, 2, 3)], "x");
    expect(got).toEqual([
      { row: 1, col: 2, value: "x" },
      { row: 1, col: 3, value: "x" },
      { row: 2, col: 2, value: "x" },
      { row: 2, col: 3, value: "x" },
    ]);
  });

  it("重なった所は1回だけ出す", () => {
    const got = fillPatches([range(0, 0, 1, 1), range(1, 1, 2, 2)], "x");
    expect(got).toHaveLength(4 + 4 - 1);
    const keys = got.map((c) => `${c.row}:${c.col}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("1セルだけなら1つ", () => {
    expect(fillPatches([range(3, 4, 3, 4)], "v")).toEqual([
      { row: 3, col: 4, value: "v" },
    ]);
  });
});

describe("表を流し込む左上", () => {
  it("範囲の左上から入れる (カーソルが右下にあっても)", () => {
    const at = pasteAnchor({ row: 9, col: 5 }, [range(3, 1, 9, 5)]);
    expect(at).toEqual({ row: 3, col: 1 });
  });

  it("離れた所をいくつも選んでいるときはカーソルから", () => {
    const at = pasteAnchor({ row: 7, col: 7 }, [
      range(0, 0, 1, 1),
      range(5, 5, 6, 6),
    ]);
    expect(at).toEqual({ row: 7, col: 7 });
  });

  it("選んでいなければカーソルから", () => {
    expect(pasteAnchor({ row: 2, col: 3 }, [])).toEqual({ row: 2, col: 3 });
  });
});
