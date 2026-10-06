import { describe, expect, it } from "vitest";
import {
  computeDiff,
  diffCounts,
  diffItemsOf,
  itemsToShow,
} from "./schemaDiff";
import type { ColumnInfo, IndexInfo, SchemaEntry } from "./types";

function col(name: string, colType: string, o: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, colType, nullable: false, ...o };
}

function idx(name: string, columns: string, unique = false): IndexInfo {
  return { name, columns, unique, constrained: false };
}

function table(
  name: string,
  columns: ColumnInfo[],
  indexes: IndexInfo[] = [],
  info: [string, string][] = []
): SchemaEntry {
  return {
    table: { name, tableType: "BASE TABLE" },
    detail: { columns, indexes, foreignKeys: [], info },
  };
}

const left = [
  table(
    "users",
    [col("id", "bigint"), col("name", "varchar(50)"), col("old_flag", "tinyint")],
    [idx("PRIMARY", "id", true), idx("idx_name", "name")]
  ),
  table("logs", [col("id", "bigint")]),
  table("same_one", [col("id", "int")], [idx("PRIMARY", "id", true)]),
];
const right = [
  table(
    "users",
    [col("id", "bigint"), col("name", "varchar(100)"), col("email", "varchar(255)")],
    [idx("PRIMARY", "id", true), idx("idx_name", "name, email")]
  ),
  table("orders", [col("id", "bigint"), col("user_id", "bigint")], [idx("PRIMARY", "id", true)]),
  table("same_one", [col("id", "int")], [idx("PRIMARY", "id", true)]),
];

const diff = computeDiff(left, right);
const of = (key: string) => diff.find((t) => t.key === key)!;

describe("スキーマの差分", () => {
  it("テーブルを 左のみ / 右のみ / 差異あり / 一致 に分ける", () => {
    expect(diff.map((t) => [t.key, t.status])).toEqual([
      ["logs", "removed"],
      ["orders", "added"],
      ["same_one", "same"],
      ["users", "changed"],
    ]);
  });

  it("一致しているカラムも残し、定義の順に並べる (右だけのものは後ろ)", () => {
    expect(of("users").columns.map((c) => [c.name, c.status])).toEqual([
      ["id", "same"],
      ["name", "changed"],
      ["old_flag", "removed"],
      ["email", "added"],
    ]);
    // 一致しているものは左右の型を持つ
    expect(of("users").columns[0]).toMatchObject({ left: "bigint", right: "bigint" });
    expect(of("users").columns[1].fields).toEqual([
      { label: "型", left: "varchar(50)", right: "varchar(100)" },
    ]);
    expect(of("users").columns[3].left).toBeUndefined();
    expect(of("users").columns[3].right).toBe("varchar(255)");
  });

  it("インデックスも同じ (ユニークは印を付ける)", () => {
    expect(of("users").indexes.map((i) => [i.name, i.status, i.left])).toEqual([
      ["PRIMARY", "same", "id (UNIQUE)"],
      ["idx_name", "changed", "name"],
    ]);
  });

  it("差異のみ表示では差異だけ、外すと全部を出す", () => {
    const users = of("users");
    expect(itemsToShow(users, "columns", true).map((c) => c.name)).toEqual([
      "name",
      "old_flag",
      "email",
    ]);
    expect(itemsToShow(users, "columns", false)).toHaveLength(4);
    expect(itemsToShow(users, "indexes", true).map((c) => c.name)).toEqual(["idx_name"]);
    expect(itemsToShow(users, "indexes", false)).toHaveLength(2);
    // 一致しているテーブルも、外せばカラムが並ぶ
    expect(itemsToShow(of("same_one"), "columns", true)).toEqual([]);
    expect(itemsToShow(of("same_one"), "columns", false).map((c) => c.status)).toEqual(["same"]);
  });

  it("片方にしか無いテーブルの中身は差異に数えないが、全部表示では並べる", () => {
    const orders = of("orders");
    expect(diffItemsOf(orders, "columns")).toEqual([]);
    expect(itemsToShow(orders, "columns", false).map((c) => [c.name, c.status])).toEqual([
      ["id", "added"],
      ["user_id", "added"],
    ]);
    expect(itemsToShow(of("logs"), "columns", false)[0].status).toBe("removed");
  });

  it("件数は差異だけを数える", () => {
    expect(diffCounts(diff)).toEqual({ tables: 2, columns: 3, indexes: 1 });
  });

  it("テーブルの属性 (エンジンなど) の違いも差異にする", () => {
    const d = computeDiff(
      [table("t", [col("id", "int")], [], [["エンジン", "InnoDB"]])],
      [table("t", [col("id", "int")], [], [["エンジン", "MyISAM"]])]
    );
    expect(d[0].status).toBe("changed");
    expect(d[0].attrs).toEqual([{ label: "エンジン", left: "InnoDB", right: "MyISAM" }]);
    expect(diffCounts(d)).toEqual({ tables: 1, columns: 0, indexes: 0 });
  });
});
