import { describe, expect, it } from "vitest";
import { OVERLAY_BAR, THIN_BAR, gapFor } from "./csvScrollbar";

describe("gapFor", () => {
  it("場所を取るバーなら、そのバーのぶんだけでよい", () => {
    expect(gapFor(10)).toBe(0);
    expect(gapFor(10, THIN_BAR)).toBe(THIN_BAR);
  });

  it("重なって出るバーなら、隠れないよう厚みぶんを空ける", () => {
    expect(gapFor(0)).toBe(OVERLAY_BAR);
    expect(gapFor(0, THIN_BAR)).toBe(OVERLAY_BAR);
  });
});
