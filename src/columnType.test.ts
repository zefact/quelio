import { describe, expect, it } from "vitest";
import { columnValueKind } from "./columnType";

describe("columnValueKind", () => {
  it("数値の型を見分ける", () => {
    for (const t of [
      "int",
      "int(11)",
      "int(10) unsigned",
      "INT UNSIGNED",
      "bigint",
      "tinyint(1)",
      "decimal(10,2)",
      "numeric",
      "double precision",
      "real",
      "serial",
      "money",
    ]) {
      expect(columnValueKind(t), t).toBe("number");
    }
  });

  it("真偽値の型を見分ける", () => {
    expect(columnValueKind("boolean")).toBe("bool");
    expect(columnValueKind("BOOL")).toBe("bool");
  });

  it("それ以外は引用符で囲む扱いにする", () => {
    for (const t of [
      "varchar(50)",
      "character varying(20)",
      "text",
      "date",
      "datetime",
      "timestamp without time zone",
      "json",
      "uuid",
      "enum('a','b')",
      "blob",
    ]) {
      expect(columnValueKind(t), t).toBe("text");
    }
  });

  it("型が空なら分からないものとして扱う", () => {
    expect(columnValueKind("")).toBeNull();
    expect(columnValueKind("   ")).toBeNull();
    expect(columnValueKind(undefined)).toBeNull();
  });
});
