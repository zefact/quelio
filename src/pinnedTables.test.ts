import { describe, expect, it } from "vitest";
import { orderByPinned, splitPinned } from "./pinnedTables";

const items = ["m_users", "m_shops", "t_orders", "t_items"];
const keyOf = (s: string) => s;

describe("ピン留めの並べ替え", () => {
  it("ピンが無ければ元の並びのまま", () => {
    const out = splitPinned(items, keyOf, new Set());
    expect(out.pinned).toEqual([]);
    expect(out.rest).toEqual(items);
  });

  it("ピン留めしたものだけを先に集める", () => {
    const out = splitPinned(items, keyOf, new Set(["t_orders", "m_users"]));
    // それぞれ元の並びは保つ
    expect(out.pinned).toEqual(["m_users", "t_orders"]);
    expect(out.rest).toEqual(["m_shops", "t_items"]);
  });

  it("一覧に無いピンは無視する", () => {
    const out = splitPinned(items, keyOf, new Set(["消えたテーブル"]));
    expect(out.pinned).toEqual([]);
    expect(out.rest).toEqual(items);
  });

  it("画面の並びは ピン留め → それ以外", () => {
    expect(orderByPinned(items, keyOf, new Set(["t_items"]))).toEqual([
      "t_items",
      "m_users",
      "m_shops",
      "t_orders",
    ]);
  });

  it("全部ピン留めしても重複しない", () => {
    expect(orderByPinned(items, keyOf, new Set(items))).toEqual(items);
  });
});
