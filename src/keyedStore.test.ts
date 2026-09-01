import { describe, expect, it, vi } from "vitest";
import { createKeyedStore } from "./keyedStore";

interface Sample {
  count: number;
  label: string | null;
}

const empty: Sample = { count: 0, label: null };

describe("createKeyedStore", () => {
  it("預けていないキーは毎回同じ「空」を返す", () => {
    // 参照が変わると、画面が更新され続けてしまう
    const store = createKeyedStore(empty);
    expect(store.get("a")).toBe(empty);
    expect(store.get("a")).toBe(store.get("b"));
  });

  it("書き換えた分だけ変わる", () => {
    const store = createKeyedStore(empty);
    store.patch("a", { count: 1 });
    store.patch("a", { label: "取り込み中" });
    expect(store.get("a")).toEqual({ count: 1, label: "取り込み中" });
  });

  it("キーごとに別々に持つ", () => {
    const store = createKeyedStore(empty);
    store.patch("a", { count: 3 });
    expect(store.get("b").count).toBe(0);
  });

  it("変化を知らせる (解除したら来ない)", () => {
    const store = createKeyedStore(empty);
    const seen = vi.fn();
    const off = store.subscribe("a", seen);
    store.patch("a", { count: 1 });
    // 別のキーの変化では呼ばれない
    store.patch("b", { count: 1 });
    off();
    store.patch("a", { count: 2 });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("捨てると空に戻る", () => {
    const store = createKeyedStore(empty);
    store.patch("a", { count: 1 });
    store.drop("a");
    expect(store.get("a")).toBe(empty);
  });

  it("置き場どうしは混ざらない", () => {
    const one = createKeyedStore(empty);
    const two = createKeyedStore(empty);
    one.patch("a", { count: 9 });
    expect(two.get("a").count).toBe(0);
  });
});
