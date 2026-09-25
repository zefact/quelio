import { describe, expect, it } from "vitest";
import { loadGridView, saveGridView } from "./gridViewMemo";

describe("表の見た目の控え", () => {
  it("同じデータ・同じ並びのときだけ戻す", () => {
    const data = {};
    const state = { top: 500, left: 20, shown: 400, widths: { c0: 120 }, sig: "k:c0:asc" };
    saveGridView(data, state);
    expect(loadGridView(data, "k:c0:asc")).toEqual(state);
    expect(loadGridView(data, "k::")).toBeUndefined();
    expect(loadGridView({}, "k:c0:asc")).toBeUndefined();
    expect(loadGridView(undefined, "k:c0:asc")).toBeUndefined();
  });
});
