import { describe, expect, it } from "vitest";
import { buildChart } from "./chartData";
import {
  barGeoms,
  barPath,
  lineGeoms,
  MAX_BAR_W,
  sliceGeoms,
  yScale,
} from "./chartGeom";

const box = { w: 400, h: 200, left: 40, right: 10, top: 10, bottom: 30 };
const rows = [
  ["a", "10"],
  ["b", "20"],
  ["c", "30"],
];

describe("縦の目盛", () => {
  it("大きい値ほど上に来る", () => {
    const d = buildChart(rows, 0, 1, "bar");
    const y = yScale(d, box);
    expect(y(30)).toBeLessThan(y(10));
  });

  it("0は基準線の位置になる", () => {
    const d = buildChart(rows, 0, 1, "bar");
    const y = yScale(d, box);
    // 目盛が0から始まるので、0は描画領域の下端
    expect(y(0)).toBeCloseTo(box.h - box.bottom, 5);
  });
});

describe("棒の位置", () => {
  it("並び順どおりに左から並ぶ", () => {
    const g = barGeoms(buildChart(rows, 0, 1, "bar"), box);
    expect(g.map((b) => b.point.label)).toEqual(["a", "b", "c"]);
    expect(g[0].x).toBeLessThan(g[1].x);
  });

  it("太くなりすぎない", () => {
    const g = barGeoms(buildChart([["a", "1"]], 0, 1, "bar"), box);
    expect(g[0].w).toBeLessThanOrEqual(MAX_BAR_W);
  });

  it("隣の棒と重ならない", () => {
    const g = barGeoms(buildChart(rows, 0, 1, "bar"), box);
    expect(g[0].x + g[0].w).toBeLessThan(g[1].x);
  });

  it("マイナスの値は基準線から下へ伸ばす", () => {
    const d = buildChart(
      [
        ["a", "10"],
        ["b", "-10"],
      ],
      0,
      1,
      "bar"
    );
    const y = yScale(d, box);
    const g = barGeoms(d, box);
    expect(g[1].y).toBeCloseTo(y(0), 5);
    expect(g[0].y).toBeLessThan(y(0));
  });
});

describe("折れ線の点", () => {
  it("点は区間の真ん中に置く", () => {
    const g = lineGeoms(buildChart(rows, 0, 1, "line"), box);
    expect(g.length).toBe(3);
    expect(g[0].x).toBeGreaterThan(box.left);
    expect(g[2].x).toBeLessThan(box.w - box.right);
  });

  it("点が1つでも真ん中に置く", () => {
    const g = lineGeoms(buildChart([["a", "1"]], 0, 1, "line"), box);
    expect(g[0].x).toBeCloseTo(box.left + (box.w - box.left - box.right) / 2, 5);
  });
});

describe("円の扇", () => {
  it("合計で1周ぶんになる", () => {
    const g = sliceGeoms(buildChart(rows, 0, 1, "pie"));
    const sum = g.reduce((s, x) => s + (x.to - x.from), 0);
    expect(sum).toBeCloseTo(Math.PI * 2, 5);
  });

  it("割合が大きい順に並ぶ", () => {
    const g = sliceGeoms(buildChart(rows, 0, 1, "pie"));
    expect(g[0].point.label).toBe("c");
    expect(g[0].ratio).toBeGreaterThan(g[1].ratio);
  });
});

describe("棒のかたち", () => {
  it("低い棒でも角丸が飛び出さない", () => {
    const b = {
      point: { label: "a", value: 1 },
      index: 0,
      x: 0,
      w: 20,
      y: 100,
      h: 2,
      bandX: 0,
      bandW: 30,
    };
    expect(barPath(b)).toContain("A 2 2");
  });
});
