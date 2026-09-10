import { describe, expect, it } from "vitest";
import {
  colBlock,
  colInAny,
  frameBox,
  inAny,
  inRange,
  jumpFix,
  normalize,
  rowBlock,
  rowInAny,
  selectionCells,
} from "./csvSelection";
import type { CsvRange } from "./csvSelection";

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

describe("jumpFix", () => {
  const from = { row: 2, col: 1 };
  const head = { row: 5, col: 3 };

  it("残さないなら、選んでいた範囲を消す", () => {
    expect(jumpFix(false, from, head)).toBe("clear");
  });

  it("残すなら、伸ばしていた四角をその形のまま固定する", () => {
    expect(jumpFix(true, from, head)).toEqual({ a: from, b: head });
  });

  it("伸ばしていなければ、足すものは無い", () => {
    expect(jumpFix(true, from, from)).toBeNull();
    expect(jumpFix(true, from, null)).toBeNull();
    expect(jumpFix(true, null, head)).toBeNull();
  });
});

describe("行や列が選ばれているか", () => {
  const rs: CsvRange[] = [
    { top: 2, left: 1, bottom: 4, right: 3 },
    { top: 8, left: 6, bottom: 8, right: 6 },
  ];

  it("四角に掛かっている行だけを数える", () => {
    expect(rowInAny(rs, 1)).toBe(false);
    expect(rowInAny(rs, 2)).toBe(true);
    expect(rowInAny(rs, 4)).toBe(true);
    expect(rowInAny(rs, 5)).toBe(false);
    expect(rowInAny(rs, 8)).toBe(true);
  });

  it("四角に掛かっている列だけを数える", () => {
    expect(colInAny(rs, 0)).toBe(false);
    expect(colInAny(rs, 1)).toBe(true);
    expect(colInAny(rs, 3)).toBe(true);
    expect(colInAny(rs, 5)).toBe(false);
    expect(colInAny(rs, 6)).toBe(true);
  });

  it("何も選んでいなければ false", () => {
    expect(rowInAny([], 0)).toBe(false);
    expect(colInAny([], 0)).toBe(false);
  });
});

describe("続いて選ばれているかたまり", () => {
  it("選んだ範囲の先頭と本数を返す", () => {
    const rs: CsvRange[] = [{ top: 2, left: 1, bottom: 6, right: 3 }];
    expect(rowBlock(rs, 4)).toEqual({ at: 2, count: 5 });
    expect(colBlock(rs, 2)).toEqual({ at: 1, count: 3 });
  });

  it("離れた所は別のかたまりとして数える", () => {
    const rs: CsvRange[] = [
      { top: 0, left: 0, bottom: 1, right: 0 },
      { top: 5, left: 0, bottom: 7, right: 0 },
    ];
    expect(rowBlock(rs, 0)).toEqual({ at: 0, count: 2 });
    expect(rowBlock(rs, 6)).toEqual({ at: 5, count: 3 });
  });

  it("隣り合う範囲は地続きとして数える", () => {
    const rs: CsvRange[] = [
      { top: 0, left: 0, bottom: 1, right: 0 },
      { top: 2, left: 0, bottom: 3, right: 0 },
    ];
    expect(rowBlock(rs, 1)).toEqual({ at: 0, count: 4 });
  });

  it("選んでいない所は、その1本だけ", () => {
    const rs: CsvRange[] = [{ top: 2, left: 2, bottom: 3, right: 2 }];
    expect(rowBlock(rs, 9)).toEqual({ at: 9, count: 1 });
    expect(colBlock(rs, 0)).toEqual({ at: 0, count: 1 });
    expect(rowBlock([], 4)).toEqual({ at: 4, count: 1 });
  });

  it("先頭の行や列でも上へ行き過ぎない", () => {
    const rs: CsvRange[] = [{ top: 0, left: 0, bottom: 0, right: 0 }];
    expect(rowBlock(rs, 0)).toEqual({ at: 0, count: 1 });
    expect(colBlock(rs, 0)).toEqual({ at: 0, count: 1 });
  });
});
