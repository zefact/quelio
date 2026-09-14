import { describe, expect, it } from "vitest";
import { boundingBox, fitView, type ErBox } from "./erFit";

/** 画面に出したときの、箱の左上と右下 */
function screenBox(box: ErBox, v: { x: number; y: number; scale: number }) {
  return {
    left: v.x + box.minX * v.scale,
    top: v.y + box.minY * v.scale,
    right: v.x + box.maxX * v.scale,
    bottom: v.y + box.maxY * v.scale,
  };
}

const LIM = {
  width: 1000,
  height: 600,
  pad: 40,
  minScale: 0.12,
  maxScale: 1,
};

describe("boundingBox", () => {
  it("置いてある箱を全部囲む", () => {
    expect(
      boundingBox([
        { x: 10, y: 20, w: 100, h: 50 },
        { x: 200, y: 0, w: 80, h: 300 },
      ])
    ).toEqual({ minX: 10, minY: 0, maxX: 280, maxY: 300 });
  });

  it("マイナスの座標も左上として数える", () => {
    expect(
      boundingBox([
        { x: -500, y: -200, w: 100, h: 50 },
        { x: 0, y: 0, w: 100, h: 50 },
      ])
    ).toEqual({ minX: -500, minY: -200, maxX: 100, maxY: 50 });
  });

  it("1つも無ければ null", () => {
    expect(boundingBox([])).toBeNull();
  });
});

describe("fitView", () => {
  it("大きい図は縮めて、はみ出さない", () => {
    const box = { minX: 0, minY: 0, maxX: 4000, maxY: 2000 };
    const v = fitView(box, LIM);
    expect(v.scale).toBeLessThan(1);
    const s = screenBox(box, v);
    expect(s.left).toBeGreaterThanOrEqual(0);
    expect(s.top).toBeGreaterThanOrEqual(0);
    expect(s.right).toBeLessThanOrEqual(LIM.width);
    expect(s.bottom).toBeLessThanOrEqual(LIM.height);
  });

  it("左や上へ動かしたテーブルも画面の中に入る", () => {
    // 以前は右下しか見ておらず、この形だと左のテーブルが画面の外に残っていた
    const box = { minX: -1200, minY: -400, maxX: 600, maxY: 500 };
    const v = fitView(box, LIM);
    const s = screenBox(box, v);
    expect(s.left).toBeGreaterThanOrEqual(0);
    expect(s.top).toBeGreaterThanOrEqual(0);
    expect(s.right).toBeLessThanOrEqual(LIM.width);
    expect(s.bottom).toBeLessThanOrEqual(LIM.height);
  });

  it("小さい図は引き伸ばさず、真ん中に置く", () => {
    const box = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
    const v = fitView(box, LIM);
    expect(v.scale).toBe(1);
    const s = screenBox(box, v);
    expect(s.left + s.right).toBeCloseTo(LIM.width);
    expect(s.top + s.bottom).toBeCloseTo(LIM.height);
  });

  it("余白のぶんは必ず残す", () => {
    const box = { minX: 0, minY: 0, maxX: 4000, maxY: 2000 };
    const v = fitView(box, LIM);
    const s = screenBox(box, v);
    expect(s.left).toBeGreaterThanOrEqual(LIM.pad - 0.001);
    expect(s.top).toBeGreaterThanOrEqual(LIM.pad - 0.001);
  });

  it("縮めすぎない (下限で止める)", () => {
    const box = { minX: 0, minY: 0, maxX: 1_000_000, maxY: 1_000_000 };
    expect(fitView(box, LIM).scale).toBe(LIM.minScale);
  });

  it("下限まで縮めても収まらない図は、真ん中に置く", () => {
    // これ以上縮めると読めないので、収まらないことより読めることを取る
    const box = { minX: 0, minY: 0, maxX: 1_000_000, maxY: 1_000_000 };
    const v = fitView(box, LIM);
    const s = screenBox(box, v);
    expect(s.left + s.right).toBeCloseTo(LIM.width);
    expect(s.top + s.bottom).toBeCloseTo(LIM.height);
  });

  it("幅も高さも0の図でも壊れない", () => {
    const v = fitView({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, LIM);
    expect(Number.isFinite(v.x)).toBe(true);
    expect(Number.isFinite(v.y)).toBe(true);
    expect(v.scale).toBe(1);
  });
});
