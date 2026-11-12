import { beforeEach, describe, expect, it } from "vitest";
import {
  dropFilters,
  recallBuilt,
  recallFilter,
  rememberBuilt,
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

describe("作った条件の記憶", () => {
  const conds = [{ column: "status", op: "eq" as const, value: "1" }];

  it("入力欄がそのときのままなら、前に作った条件を返す", () => {
    rememberBuilt("s1", "shop", "orders", { conds, where: "status = 1" });
    expect(recallBuilt("s1", "shop", "orders", "status = 1")).toEqual(conds);
    // 前後の空白だけの違いは同じとみなす
    expect(recallBuilt("s1", "shop", "orders", " status = 1 ")).toEqual(conds);
  });

  it("入力欄を書き換えたり消したりしていれば返さない", () => {
    rememberBuilt("s1", "shop", "orders", { conds, where: "status = 1" });
    expect(recallBuilt("s1", "shop", "orders", "status = 2")).toBeNull();
    expect(recallBuilt("s1", "shop", "orders", "")).toBeNull();
  });

  it("別のテーブルの条件は返さず、タブを閉じたら忘れる", () => {
    rememberBuilt("s1", "shop", "orders", { conds, where: "status = 1" });
    expect(recallBuilt("s1", "shop", "items", "status = 1")).toBeNull();
    dropFilters("s1");
    expect(recallBuilt("s1", "shop", "orders", "status = 1")).toBeNull();
  });
});
