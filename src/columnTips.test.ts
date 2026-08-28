import { describe, expect, it } from "vitest";
import { buildColumnTips, buildSchemaTips, columnTipText } from "./columnTips";
import type { ColumnInfo, SchemaEntry } from "./types";

const col = (over: Partial<ColumnInfo> & { name: string }): ColumnInfo => ({
  colType: "int",
  nullable: true,
  ...over,
});

describe("columnTipText", () => {
  it("論理名・補足・属性を行で分ける", () => {
    expect(
      columnTipText(
        col({
          name: "id",
          colType: "bigint",
          nullable: false,
          key: "PRI",
          comment: "ID（採番）",
        }),
        "（"
      )
    ).toBe("ID\n採番\nbigint / NOT NULL / 主キー");
  });

  it("コメントが無ければ属性だけ", () => {
    expect(columnTipText(col({ name: "a" }), "（")).toBe("int");
  });
});

describe("buildColumnTips", () => {
  it("カラム名は小文字で引ける", () => {
    const tips = buildColumnTips([col({ name: "UserId" })], "（");
    expect(tips["userid"]).toBe("int");
  });

  it("同名カラムは最初の定義を使う", () => {
    const tips = buildColumnTips(
      [col({ name: "a", colType: "int" }), col({ name: "A", colType: "text" })],
      "（"
    );
    expect(tips["a"]).toBe("int");
  });
});

describe("buildSchemaTips", () => {
  const entry = (name: string, columns: ColumnInfo[]): SchemaEntry => ({
    table: { name, tableType: "BASE TABLE" },
    detail: { columns, indexes: [], foreignKeys: [], info: [] },
  });

  it("コメントのあるカラムだけを、出典付きで拾う", () => {
    const tips = buildSchemaTips(
      [entry("users", [col({ name: "id", comment: "ID" }), col({ name: "x" })])],
      "（"
    );
    expect(tips["id"]).toBe("ID\nint\n(users)");
    expect(tips["x"]).toBeUndefined();
  });

  it("同名カラムは最初に見つかった定義を使う", () => {
    const tips = buildSchemaTips(
      [
        entry("a", [col({ name: "id", comment: "Aの" })]),
        entry("b", [col({ name: "id", comment: "Bの" })]),
      ],
      "（"
    );
    expect(tips["id"]).toContain("(a)");
  });
});
