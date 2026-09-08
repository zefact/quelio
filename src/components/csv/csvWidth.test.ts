import { describe, expect, it } from "vitest";
import { MAX_W, MIN_W, fitWidth, textWidth } from "./csvWidth";

describe("textWidth", () => {
  it("半角は1文字ぶん", () => {
    expect(textWidth("abc")).toBe(3);
  });

  it("漢字とかなは2文字ぶん", () => {
    expect(textWidth("山田")).toBe(4);
    expect(textWidth("やまだ")).toBe(6);
  });

  it("混ざっていても足し合わせる", () => {
    expect(textWidth("A山")).toBe(3);
  });

  it("空の文字は0", () => {
    expect(textWidth("")).toBe(0);
  });
});

describe("fitWidth", () => {
  it("見出しより中身が長ければ中身に合わせる", () => {
    const short = fitWidth("名前", []);
    const long = fitWidth("名前", ["山田太郎左衛門と申します"]);
    expect(long).toBeGreaterThan(short);
  });

  it("中身より見出しが長ければ見出しに合わせる", () => {
    const wide = fitWidth("とても長い見出しの列です", ["1"]);
    expect(wide).toBeGreaterThan(fitWidth("A", ["1"]));
  });

  it("いちばん長い値に合わせる", () => {
    expect(fitWidth("a", ["1", "1234567890123456789012345", "12"])).toBe(
      fitWidth("a", ["1234567890123456789012345"])
    );
  });

  it("空の列でも潰れない", () => {
    expect(fitWidth("", [])).toBe(MIN_W);
  });

  it("長すぎる値でも広がりすぎない", () => {
    expect(fitWidth("a", ["x".repeat(500)])).toBe(MAX_W);
  });

  it("返す幅は下限と上限の間に収まる", () => {
    for (const v of ["", "a", "あ".repeat(30), "x".repeat(200)]) {
      const w = fitWidth("見出し", [v]);
      expect(w).toBeGreaterThanOrEqual(MIN_W);
      expect(w).toBeLessThanOrEqual(MAX_W);
    }
  });
});
