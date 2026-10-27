import { describe, expect, it } from "vitest";
import { carryWidths } from "./csvWidthCarry";

const fit = (name: string) => name.length * 10;

describe("carryWidths", () => {
  it("列名が同じなら幅をそのまま使う", () => {
    expect(carryWidths(["a", "b"], [100, 200], ["a", "b"], fit)).toEqual([
      100, 200,
    ]);
  });

  it("名前が変わった列は、名前が収まるまで広げる (狭めない)", () => {
    expect(
      carryWidths(["a", "b"], [100, 20], ["a", "longname"], fit)
    ).toEqual([100, 80]);
    expect(carryWidths(["a", "b"], [100, 200], ["a", "c"], fit)).toEqual([
      100, 200,
    ]);
  });

  it("足した位置に新しい列の幅を差し込む", () => {
    const next = ["a", "新", "新", "b", "c"];
    const shift = { columns: next, at: 1, delta: 2 };
    expect(
      carryWidths(["a", "b", "c"], [100, 200, 300], next, fit, shift)
    ).toEqual([100, 10, 10, 200, 300]);
  });

  it("末尾に足しても前の幅は変わらない", () => {
    const next = ["1", "2", "3"];
    const shift = { columns: next, at: 2, delta: 1 };
    expect(carryWidths(["1", "2"], [100, 200], next, fit, shift)).toEqual([
      100, 200, 10,
    ]);
  });

  it("消した位置の幅を抜く", () => {
    const next = ["a", "d"];
    const shift = { columns: next, at: 1, delta: -2 };
    expect(
      carryWidths(["a", "b", "c", "d"], [1, 2, 3, 4], next, fit, shift)
    ).toEqual([1, 4]);
  });

  it("列数が変わったのに手がかりが無ければ引き継がない", () => {
    expect(carryWidths(["a"], [100], ["a", "b"], fit)).toBeNull();
  });

  it("手がかりと列数が合わなければ引き継がない", () => {
    const shift = { columns: ["a", "b"], at: 0, delta: 2 };
    expect(carryWidths(["a"], [100], ["a", "b"], fit, shift)).toBeNull();
  });

  it("幅がまだ揃っていなければ引き継がない", () => {
    expect(carryWidths(["a", "b"], [100], ["a", "b"], fit)).toBeNull();
  });
});
