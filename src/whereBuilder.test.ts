import { describe, expect, it } from "vitest";
import { buildWhere, condSql, isNumericLiteral, quoteValue } from "./whereBuilder";
import type { FilterCond } from "./whereBuilder";

/** テストではMySQL風のバッククォートで囲む */
const q = (n: string) => `\`${n}\``;
const cond = (o: Partial<FilterCond>): FilterCond => ({
  column: "status",
  op: "eq",
  value: "",
  ...o,
});

describe("値の書き方", () => {
  it("数値は引用符なしで置く", () => {
    expect(isNumericLiteral("12")).toBe(true);
    expect(isNumericLiteral("-3.5")).toBe(true);
    expect(isNumericLiteral("012a")).toBe(false);
    expect(condSql(cond({ value: "1" }), q)).toBe("`status` = 1");
  });

  it("文字列は引用符で囲む", () => {
    expect(condSql(cond({ column: "name", value: "山田" }), q)).toBe(
      "`name` = '山田'"
    );
  });

  it("シングルクォートを逃がす", () => {
    expect(quoteValue("O'Brien")).toBe("'O''Brien'");
    expect(condSql(cond({ column: "name", value: "O'Brien" }), q)).toBe(
      "`name` = 'O''Brien'"
    );
  });

  it("true / false / null はそのまま書く", () => {
    expect(condSql(cond({ value: "true" }), q)).toBe("`status` = TRUE");
    expect(condSql(cond({ value: "null" }), q)).toBe("`status` = NULL");
  });
});

describe("演算子", () => {
  it("比較をそのまま並べる", () => {
    expect(condSql(cond({ op: "ne", value: "1" }), q)).toBe("`status` <> 1");
    expect(condSql(cond({ op: "ge", value: "1" }), q)).toBe("`status` >= 1");
    expect(condSql(cond({ op: "lt", value: "1" }), q)).toBe("`status` < 1");
  });

  it("含む・で始まる・で終わるはLIKEにする", () => {
    const c = (op: FilterCond["op"]) =>
      condSql(cond({ column: "name", op, value: "山" }), q);
    expect(c("contains")).toBe("`name` LIKE '%山%'");
    expect(c("starts")).toBe("`name` LIKE '山%'");
    expect(c("ends")).toBe("`name` LIKE '%山'");
  });

  it("いずれかはカンマで分けてINにする", () => {
    expect(condSql(cond({ op: "in", value: "1, 2 ,3" }), q)).toBe(
      "`status` IN (1, 2, 3)"
    );
    expect(condSql(cond({ column: "name", op: "in", value: "山田, 佐藤" }), q)).toBe(
      "`name` IN ('山田', '佐藤')"
    );
  });

  it("空・空でないは値を使わない", () => {
    expect(condSql(cond({ op: "null" }), q)).toBe("`status` IS NULL");
    expect(condSql(cond({ op: "notnull" }), q)).toBe("`status` IS NOT NULL");
  });
});

describe("書けない条件", () => {
  it("値が空なら条件にしない", () => {
    expect(condSql(cond({ value: "  " }), q)).toBeNull();
  });

  it("列が空なら条件にしない", () => {
    expect(condSql(cond({ column: "", value: "1" }), q)).toBeNull();
  });

  it("カンマだけのINは条件にしない", () => {
    expect(condSql(cond({ op: "in", value: " , , " }), q)).toBeNull();
  });
});

describe("WHERE句の組み立て", () => {
  it("ANDで繋ぐ", () => {
    expect(
      buildWhere(
        [
          cond({ value: "1" }),
          cond({ column: "name", op: "contains", value: "山" }),
        ],
        q
      )
    ).toBe("`status` = 1 AND `name` LIKE '%山%'");
  });

  it("書けない条件は飛ばす", () => {
    expect(buildWhere([cond({ value: "" }), cond({ value: "1" })], q)).toBe(
      "`status` = 1"
    );
  });

  it("何も書けなければ空文字", () => {
    expect(buildWhere([cond({ value: "" })], q)).toBe("");
  });
});
