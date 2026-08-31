import { describe, expect, it } from "vitest";
import {
  buildChart,
  defaultColumns,
  MAX_POINTS,
  MAX_SLICES,
  niceTicks,
  numericColumns,
  toNumber,
} from "./chartData";

describe("値として読めるか", () => {
  it("数字と小数・マイナスを読む", () => {
    expect(toNumber("120")).toBe(120);
    expect(toNumber("-3.5")).toBe(-3.5);
    expect(toNumber(" 42 ")).toBe(42);
  });

  it("桁区切りと通貨記号は落とす", () => {
    expect(toNumber("1,234")).toBe(1234);
    expect(toNumber("¥2,980")).toBe(2980);
  });

  it("日付や文字列は値にしない", () => {
    expect(toNumber("2025-08-01")).toBeNull();
    expect(toNumber("山田")).toBeNull();
    expect(toNumber("")).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber("1e3")).toBeNull();
  });
});

describe("列の見立て", () => {
  const columns = ["shop_name", "ordered_on", "total"];
  const rows = [
    ["渋谷店", "2025-08-01", "12000"],
    ["梅田店", "2025-08-02", "8000"],
    ["名駅店", "2025-08-03", "9500"],
  ];

  it("数値が多い列を値の候補にする", () => {
    expect(numericColumns(columns, rows)).toEqual([2]);
  });

  it("ラベルは数値でない列、値は数値の列を選ぶ", () => {
    expect(defaultColumns(columns, rows)).toEqual({ labelCol: 0, valueCol: 2 });
  });

  it("数値の列が無ければ選べない", () => {
    expect(defaultColumns(["a"], [["x"]])).toBeNull();
  });
});

describe("目盛", () => {
  it("切りの良い数字になる", () => {
    expect(niceTicks(0, 100)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(0, 9500)).toEqual([0, 2500, 5000, 7500, 10000]);
  });

  it("0を必ず含む", () => {
    expect(niceTicks(120, 300)[0]).toBe(0);
  });

  it("マイナスも扱える", () => {
    const t = niceTicks(-30, 60);
    expect(t[0]).toBeLessThan(0);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(60);
  });

  it("全部同じ値でも壊れない", () => {
    expect(niceTicks(5, 5).length).toBeGreaterThan(0);
  });
});

describe("グラフのデータ作り", () => {
  const rows = [
    ["渋谷店", "12000"],
    ["梅田店", "8000"],
    ["名駅店", "その他"],
  ];

  it("値が数値でない行は飛ばして数える", () => {
    const d = buildChart(rows, 0, 1, "bar");
    expect(d.points.map((p) => p.label)).toEqual(["渋谷店", "梅田店"]);
    expect(d.skipped).toBe(1);
  });

  it("ラベルのNULLはNULLと出す", () => {
    const d = buildChart([[null, "5"]], 0, 1, "bar");
    expect(d.points[0].label).toBe("NULL");
  });

  it("点が多すぎるときは先頭だけ描いて残りを数える", () => {
    const many = Array.from({ length: MAX_POINTS + 5 }, (_, i) => [
      `r${i}`,
      String(i),
    ]);
    const d = buildChart(many, 0, 1, "line");
    expect(d.points.length).toBe(MAX_POINTS);
    expect(d.omitted).toBe(5);
  });

  it("円グラフは大きい順に並べ、あふれたぶんはその他へまとめる", () => {
    const many = Array.from({ length: MAX_SLICES + 3 }, (_, i) => [
      `r${i}`,
      String(i + 1),
    ]);
    const d = buildChart(many, 0, 1, "pie");
    expect(d.points.length).toBe(MAX_SLICES + 1);
    expect(d.points[0].value).toBe(MAX_SLICES + 3);
    expect(d.points[d.points.length - 1].label).toContain("その他");
    expect(d.otherCount).toBe(3);
    // その他は残り3件 (1+2+3) の合計
    expect(d.points[d.points.length - 1].value).toBe(6);
  });

  it("円グラフは0以下の値を描かない", () => {
    const d = buildChart(
      [
        ["a", "5"],
        ["b", "-3"],
        ["c", "0"],
      ],
      0,
      1,
      "pie"
    );
    expect(d.points.map((p) => p.label)).toEqual(["a"]);
    expect(d.skipped).toBe(2);
  });
});
