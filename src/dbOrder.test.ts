import { describe, expect, it } from "vitest";
import { databaseOptions } from "./dbOrder";

const SYSTEM = ["information_schema", "mysql", "performance_schema", "sys"];

describe("データベースの並び", () => {
  it("自分のDBを先に、サーバーのDBを後ろにする", () => {
    const got = databaseOptions(
      ["information_schema", "app", "mysql", "shop"],
      SYSTEM
    );
    expect(got.map((o) => o.value)).toEqual([
      "app",
      "shop",
      "information_schema",
      "mysql",
    ]);
  });

  it("サーバーのDBの先頭にだけ区切りを付ける", () => {
    const got = databaseOptions(["app", "mysql", "sys"], SYSTEM);
    expect(got.map((o) => o.separator ?? false)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("かたまりの中の並びは変えない", () => {
    const got = databaseOptions(["shop", "app"], SYSTEM);
    expect(got.map((o) => o.value)).toEqual(["shop", "app"]);
  });

  it("大文字小文字は問わない", () => {
    const got = databaseOptions(["app", "MySQL"], SYSTEM);
    expect(got.map((o) => o.value)).toEqual(["app", "MySQL"]);
    expect(got[1].separator).toBe(true);
  });

  it("自分のDBが無ければ区切りを引かない", () => {
    const got = databaseOptions(["mysql", "sys"], SYSTEM);
    expect(got.every((o) => !o.separator)).toBe(true);
  });

  it("サーバーのDBの一覧が空でも落ちない", () => {
    const got = databaseOptions(["app", "shop"], []);
    expect(got.map((o) => o.value)).toEqual(["app", "shop"]);
  });

  it("DBが1つも無ければ空", () => {
    expect(databaseOptions([], SYSTEM)).toEqual([]);
  });
});
