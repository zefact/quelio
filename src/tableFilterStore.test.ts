import { beforeEach, describe, expect, it } from "vitest";
import {
  dropFilters,
  recallFilter,
  rememberFilter,
  resetFilterStore,
} from "./tableFilterStore";

beforeEach(() => resetFilterStore());

describe("tableFilterStore", () => {
  it("覚えた条件をそのまま返す", () => {
    rememberFilter("s1", "shop", "orders", "status = 1");
    expect(recallFilter("s1", "shop", "orders")).toBe("status = 1");
  });

  it("覚えていないテーブルは空文字", () => {
    expect(recallFilter("s1", "shop", "orders")).toBe("");
  });

  it("接続・DB・テーブルが1つでも違えば別物として扱う", () => {
    rememberFilter("s1", "shop", "orders", "a = 1");
    expect(recallFilter("s2", "shop", "orders")).toBe("");
    expect(recallFilter("s1", "log", "orders")).toBe("");
    expect(recallFilter("s1", "shop", "items")).toBe("");
  });

  it("名前に区切りと同じ文字が入っても混ざらない", () => {
    rememberFilter("s1", "a", "b c", "x = 1");
    expect(recallFilter("s1", "a b", "c")).toBe("");
  });

  it("空にしたら忘れる (次に開いたとき全件になる)", () => {
    rememberFilter("s1", "shop", "orders", "a = 1");
    rememberFilter("s1", "shop", "orders", "   ");
    expect(recallFilter("s1", "shop", "orders")).toBe("");
  });

  it("タブを閉じたら、そのタブのぶんだけ忘れる", () => {
    rememberFilter("s1", "shop", "orders", "a = 1");
    rememberFilter("s2", "shop", "orders", "b = 2");
    dropFilters("s1");
    expect(recallFilter("s1", "shop", "orders")).toBe("");
    expect(recallFilter("s2", "shop", "orders")).toBe("b = 2");
  });
});
