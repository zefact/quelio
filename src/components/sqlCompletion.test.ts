import { describe, expect, it } from "vitest";
import { keepOrder, orderBoost } from "./sqlCompletion";

describe("orderBoost", () => {
  it("先に定義されたものほど大きい", () => {
    const boosts = [0, 1, 2, 3].map((at) => orderBoost(at, 4));
    expect(boosts).toEqual([...boosts].sort((a, b) => b - a));
    expect(new Set(boosts).size).toBe(4);
  });

  it("絞り込みの一致度 (100点刻み) を追い越さない幅に収まる", () => {
    // 端どうしの差が200以上あると、一致度の低い候補が上に来てしまう
    for (const total of [1, 2, 50, 500]) {
      for (const at of [0, total - 1]) {
        expect(Math.abs(orderBoost(at, total))).toBeLessThanOrEqual(99);
      }
    }
  });

  it("カラムが多くても順番が入れ替わらない", () => {
    const boosts = Array.from({ length: 500 }, (_, at) => orderBoost(at, 500));
    for (let at = 1; at < boosts.length; at++) {
      expect(boosts[at]).toBeLessThan(boosts[at - 1]);
    }
  });
});

describe("keepOrder", () => {
  it("並べた順のまま重みを付ける", () => {
    const out = keepOrder([{ label: "id" }, { label: "created_at" }]);
    expect(out.map((o) => o.label)).toEqual(["id", "created_at"]);
    expect(out[0].boost).toBeGreaterThan(out[1].boost!);
  });

  it("元の候補は書き換えない", () => {
    const src = [{ label: "id" }, { label: "name" }];
    keepOrder(src);
    expect(src[0]).not.toHaveProperty("boost");
  });
});
