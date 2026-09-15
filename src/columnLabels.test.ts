import { describe, expect, it } from "vitest";
import { buildColumnLabels, buildSchemaLabels } from "./columnLabels";
import type { ColumnInfo, SchemaEntry } from "./types";

const col = (over: Partial<ColumnInfo> & { name: string }): ColumnInfo => ({
  colType: "int",
  nullable: true,
  ...over,
});

const entry = (table: string, columns: ColumnInfo[]): SchemaEntry =>
  ({
    table: { name: table },
    detail: { columns },
  }) as unknown as SchemaEntry;

describe("buildColumnLabels", () => {
  it("論理名だけを取り出す (補足は入れない)", () => {
    expect(
      buildColumnLabels([col({ name: "id", comment: "利用者ID（採番）" })], "（")
    ).toEqual({ id: "利用者ID" });
  });

  it("コメントの無いカラムは入れない", () => {
    expect(buildColumnLabels([col({ name: "a" })], "（")).toEqual({});
  });

  it("区切りが無いコメントは全体を論理名にする", () => {
    expect(buildColumnLabels([col({ name: "a", comment: "名前" })], "（")).toEqual(
      { a: "名前" }
    );
  });

  it("大文字小文字を問わず引けるようにする", () => {
    expect(buildColumnLabels([col({ name: "UserId", comment: "利用者" })], "（"))
      .toEqual({ userid: "利用者" });
  });

  it("同名なら日本語名のある最初のものを採る", () => {
    expect(
      buildColumnLabels(
        [col({ name: "id", comment: "先" }), col({ name: "id", comment: "後" })],
        "（"
      )
    ).toEqual({ id: "先" });
  });
});

describe("buildSchemaLabels", () => {
  it("DB全体から集める", () => {
    const labels = buildSchemaLabels(
      [
        entry("users", [col({ name: "id", comment: "利用者ID（採番）" })]),
        entry("orders", [col({ name: "amount", comment: "金額" })]),
      ],
      "（"
    );
    expect(labels).toEqual({ id: "利用者ID", amount: "金額" });
  });

  it("同名のカラムは先に見つけたテーブルのものを使う", () => {
    const labels = buildSchemaLabels(
      [
        entry("users", [col({ name: "name", comment: "利用者名" })]),
        entry("items", [col({ name: "name", comment: "商品名" })]),
      ],
      "（"
    );
    expect(labels.name).toBe("利用者名");
  });

  it("コメントの無いカラムは入れない", () => {
    expect(buildSchemaLabels([entry("t", [col({ name: "a" })])], "（")).toEqual({});
  });
});
