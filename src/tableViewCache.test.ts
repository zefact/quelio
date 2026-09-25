import { beforeEach, describe, expect, it } from "vitest";
import {
  dropTableViews,
  resetTableViewCache,
  stashTableView,
  TABLE_CACHE_LIMIT,
  takeTableView,
  type CachedTableView,
} from "./tableViewCache";
import type { QueryResult, TableDetail } from "./types";

const detail = {} as TableDetail;
const result = { rows: [] } as unknown as QueryResult;

function view(where = ""): CachedTableView {
  return { detail, data: { data: result, loading: false, error: null, where } };
}

beforeEach(() => resetTableViewCache());

describe("テーブルの控え", () => {
  it("預けたものをそのまま返し、取り出したら控えから外す", () => {
    stashTableView("s1", "db", "users", view("id > 3"));
    const got = takeTableView("s1", "db", "users");
    expect(got?.data.data).toBe(result);
    expect(got?.data.where).toBe("id > 3");
    expect(takeTableView("s1", "db", "users")).toBeUndefined();
  });

  it("取得中・失敗のデータは持たない (戻ったら取り直す)", () => {
    stashTableView("s1", "db", "a", {
      detail,
      data: { data: result, loading: true, error: null, where: "x" },
    });
    const got = takeTableView("s1", "db", "a");
    expect(got?.data).toEqual({ data: null, loading: false, error: null, where: "x" });
    expect(got?.detail).toBe(detail);
  });

  it("上限を超えたら古いものから捨てる", () => {
    for (let i = 0; i <= TABLE_CACHE_LIMIT; i++) stashTableView("s1", "db", `t${i}`, view());
    expect(takeTableView("s1", "db", "t0")).toBeUndefined();
    expect(takeTableView("s1", "db", `t${TABLE_CACHE_LIMIT}`)).toBeDefined();
  });

  it("接続タブ・DBごとに分ける", () => {
    stashTableView("s1", "db1", "t", view());
    stashTableView("s2", "db1", "t", view());
    expect(takeTableView("s1", "db2", "t")).toBeUndefined();
    dropTableViews("s1");
    expect(takeTableView("s1", "db1", "t")).toBeUndefined();
    expect(takeTableView("s2", "db1", "t")).toBeDefined();
  });
});
