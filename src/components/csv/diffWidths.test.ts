import { describe, expect, it } from "vitest";
import { dragWidth } from "./diffWidths";
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
