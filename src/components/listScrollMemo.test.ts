import { describe, expect, it } from "vitest";
import { LIST_SCROLL_LIMIT, loadListScroll, saveListScroll } from "./listScrollMemo";

describe("一覧のスクロール位置の控え", () => {
  it("一覧ごとに覚え、知らない一覧は先頭にする", () => {
    saveListScroll("tabA\u0000shop", 480);
    saveListScroll("tabB\u0000shop", 20);
    expect(loadListScroll("tabA\u0000shop")).toBe(480);
    expect(loadListScroll("tabB\u0000shop")).toBe(20);
    expect(loadListScroll("tabC\u0000shop")).toBe(0);
  });

  it("上限を超えたら古いものから捨てる", () => {
    saveListScroll("old", 5);
    for (let i = 0; i < LIST_SCROLL_LIMIT; i++) saveListScroll(`k${i}`, i);
    expect(loadListScroll("old")).toBe(0);
  });
});
