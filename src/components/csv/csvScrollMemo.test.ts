import { describe, expect, it } from "vitest";
import { CSV_SCROLL_LIMIT, loadCsvScroll, saveCsvScroll } from "./csvScrollMemo";

describe("CSVの表のスクロール位置の控え", () => {
  it("表ごとに覚え、上限を超えたら古いものから捨てる", () => {
    saveCsvScroll("left:d1", { top: 1200, left: 80 });
    expect(loadCsvScroll("left:d1")).toEqual({ top: 1200, left: 80 });
    expect(loadCsvScroll("right:d1")).toBeUndefined();
    for (let i = 0; i < CSV_SCROLL_LIMIT; i++) saveCsvScroll(`k${i}`, { top: i, left: 0 });
    expect(loadCsvScroll("left:d1")).toBeUndefined();
    expect(loadCsvScroll(`k${CSV_SCROLL_LIMIT - 1}`)).toEqual({ top: CSV_SCROLL_LIMIT - 1, left: 0 });
  });
});
