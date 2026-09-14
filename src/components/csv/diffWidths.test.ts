import { describe, expect, it } from "vitest";
import { dragWidth, splitWidths } from "./diffWidths";
import { MAX_W, MIN_W } from "./csvWidth";

describe("dragWidth", () => {
  it("動かしたぶんだけ広がる", () => {
    expect(dragWidth(120, 40)).toBe(160);
  });

  it("左へ動かせば狭まる", () => {
    expect(dragWidth(120, -40)).toBe(80);
  });

  it("下限より狭くはならない", () => {
    expect(dragWidth(100, -9999)).toBe(MIN_W);
  });

  it("上限より広くはならない", () => {
    expect(dragWidth(100, 9999)).toBe(MAX_W);
  });

  it("動かさなければそのまま", () => {
    expect(dragWidth(123, 0)).toBe(123);
  });
});

describe("splitWidths", () => {
  const start = [100, 200, 100];

  it("動かさなければそのまま", () => {
    expect(splitWidths(start, 0)).toEqual(start);
  });

  it("右へ動かすと、合計がそのぶん広がる", () => {
    // 合計400を+400 → 倍率2倍
    expect(splitWidths(start, 400)).toEqual([200, 400, 200]);
  });

  it("左へ動かすと、合計がそのぶん狭まる", () => {
    // 合計400を-200 → 倍率0.5倍
    expect(splitWidths(start, -200)).toEqual([MIN_W, 100, MIN_W]);
  });

  it("列どうしの幅の比は保たれる", () => {
    const got = splitWidths([100, 200], 150);
    expect(got[1] / got[0]).toBeCloseTo(2, 1);
  });

  it("下限に当たった列は、それ以上狭まらない", () => {
    const got = splitWidths(start, -9999);
    expect(got).toEqual([MIN_W, MIN_W, MIN_W]);
  });

  it("上限に当たった列は、それ以上広がらない", () => {
    const got = splitWidths(start, 99999);
    expect(got).toEqual([MAX_W, MAX_W, MAX_W]);
  });

  it("列が1つも無ければ何も起きない", () => {
    expect(splitWidths([], 100)).toEqual([]);
  });

  it("元の配列は変えない", () => {
    const src = [...start];
    splitWidths(src, 300);
    expect(src).toEqual(start);
  });
});
