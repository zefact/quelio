import { describe, expect, it } from "vitest";
import {
  frameBox,
  inAny,
  inRange,
  normalize,
  selectionCells,
} from "./csvSelection";

describe("normalize", () => {
  it("どちらを先に渡しても同じ四角になる", () => {
    const a = { row: 5, col: 2 };
    const b = { row: 1, col: 7 };
    expect(normalize(a, b)).toEqual({ top: 1, bottom: 5, left: 2, right: 7 });
    expect(normalize(b, a)).toEqual({ top: 1, bottom: 5, left: 2, right: 7 });
  });

  it("同じセルなら1つぶんの四角になる", () => {
    expect(normalize({ row: 3, col: 4 }, { row: 3, col: 4 })).toEqual({
      top: 3,
      bottom: 3,
      left: 4,
      right: 4,
    });
  });
});

describe("inRange / inAny", () => {
  const r = { top: 1, bottom: 3, left: 2, right: 4 };

  it("端も中に入っている", () => {
    expect(inRange(r, 1, 2)).toBe(true);
    expect(inRange(r, 3, 4)).toBe(true);
  });

  it("外は入っていない", () => {
    expect(inRange(r, 0, 2)).toBe(false);
    expect(inRange(r, 2, 5)).toBe(false);
  });

  it("離れた四角のどれかに入っていればよい", () => {
    const other = { top: 9, bottom: 9, left: 0, right: 0 };
    expect(inAny([r, other], 9, 0)).toBe(true);
    expect(inAny([r, other], 7, 7)).toBe(false);
  });
});

describe("selectionCells", () => {
  it("四角の面積を足す", () => {
    expect(selectionCells([{ top: 0, bottom: 2, left: 0, right: 1 }])).toBe(6);
  });

  it("離れた四角はそれぞれ数える", () => {
    expect(
      selectionCells([
        { top: 0, bottom: 0, left: 0, right: 0 },
        { top: 5, bottom: 6, left: 1, right: 2 },
      ])
    ).toBe(5);
  });

  it("何も選んでいなければ0", () => {
    expect(selectionCells([])).toBe(0);
  });
});

describe("frameBox", () => {
  const lefts = [64, 164, 264];
  const widths = [100, 100, 80];

  it("列の幅を足して枠の大きさを出す", () => {
    const box = frameBox(
      { top: 2, bottom: 4, left: 0, right: 1 },
      lefts,
      widths,
      26,
      64
    );
    expect(box).toEqual({ left: 64, top: 52, width: 200, height: 78 });
  });

  it("1セルなら1つぶんの大きさになる", () => {
    const box = frameBox(
      { top: 0, bottom: 0, left: 2, right: 2 },
      lefts,
      widths,
      26,
      64
    );
    expect(box).toEqual({ left: 264, top: 0, width: 80, height: 26 });
  });
});
