import { describe, expect, it } from "vitest";
import { moveItem } from "./moveItem";

describe("moveItem", () => {
  const abc = () => ["a", "b", "c", "d"];

  it("右へ動かす", () => {
    expect(moveItem(abc(), 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("左へ動かす", () => {
    expect(moveItem(abc(), 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("隣と入れ替える", () => {
    expect(moveItem(abc(), 1, 2)).toEqual(["a", "c", "b", "d"]);
  });

  it("末尾へ動かす", () => {
    expect(moveItem(abc(), 0, 3)).toEqual(["b", "c", "d", "a"]);
  });

  it("先頭へ動かす", () => {
    expect(moveItem(abc(), 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("元の配列は変えない", () => {
    const src = abc();
    moveItem(src, 0, 3);
    expect(src).toEqual(["a", "b", "c", "d"]);
  });

  it("同じ位置なら、そのままの配列を返す (描き直しを起こさない)", () => {
    const src = abc();
    expect(moveItem(src, 2, 2)).toBe(src);
  });

  it("範囲の外なら、そのままの配列を返す", () => {
    const src = abc();
    expect(moveItem(src, -1, 2)).toBe(src);
    expect(moveItem(src, 0, 9)).toBe(src);
    expect(moveItem(src, 9, 0)).toBe(src);
  });

  it("1つしか無ければ何も起きない", () => {
    const src = ["a"];
    expect(moveItem(src, 0, 0)).toBe(src);
  });

  it("何度動かしても中身は増えも減りもしない", () => {
    let list = abc();
    list = moveItem(list, 0, 3);
    list = moveItem(list, 2, 0);
    list = moveItem(list, 1, 3);
    expect([...list].sort()).toEqual(["a", "b", "c", "d"]);
  });
});
