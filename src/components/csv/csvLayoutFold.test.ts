import { afterEach, describe, expect, it } from "vitest";
import {
  loadClosed,
  pruneClosed,
  renameClosed,
  saveClosed,
  toggleClosed,
} from "./csvLayoutFold";

/** テスト環境の localStorage を簡易に用意する */
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  },
});

afterEach(() => store.clear());

describe("フォルダの開閉", () => {
  it("押すたびに入れ替わる (元の集まりは書き換えない)", () => {
    const none = new Set<string>();
    const shut = toggleClosed(none, "受注");
    expect([...shut]).toEqual(["受注"]);
    expect([...toggleClosed(shut, "受注")]).toEqual([]);
    expect(none.size).toBe(0);
  });

  it("名前を変えたら、閉じたままその名前へ引き継ぐ", () => {
    expect([...renameClosed(new Set(["受注"]), "受注", "発注")]).toEqual([
      "発注",
    ]);
  });

  it("開いているフォルダの名前を変えても閉じない", () => {
    expect(renameClosed(new Set(["他"]), "受注", "発注").has("発注")).toBe(false);
  });

  it("もう無いフォルダの分は捨てる", () => {
    expect([...pruneClosed(new Set(["受注", "古い"]), ["受注", "新"])]).toEqual([
      "受注",
    ]);
  });
});

describe("開閉を覚える", () => {
  it("初めては全部開いている", () => {
    expect(loadClosed().size).toBe(0);
  });

  it("覚えたものを読み直せる", () => {
    saveClosed(new Set(["受注", "発注"]));
    expect([...loadClosed()]).toEqual(["受注", "発注"]);
  });

  it("壊れた中身は無かったことにする", () => {
    store.set("quelio.csvLayoutClosed", "{oops");
    expect(loadClosed().size).toBe(0);
    store.set("quelio.csvLayoutClosed", '{"a":1}');
    expect(loadClosed().size).toBe(0);
    store.set("quelio.csvLayoutClosed", '["受注", 3]');
    expect([...loadClosed()]).toEqual(["受注"]);
  });
});
