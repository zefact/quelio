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

/** テスト用のテーブル定義 (列名 → 型) */
const TYPES: Record<string, string> = {
  status: "int(11)",
  qty: "decimal(10,2)",
  name: "varchar(50)",
  code: "varchar(10)",
  is_active: "boolean",
  order_date: "date",
  memo: "text",
  loose: "",
};
const t = (n: string) => TYPES[n];

describe("値の書き方 (型が分からないとき)", () => {
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

describe("値の書き方 (列の型を見る)", () => {
  it("数値の列は引用符を付けない", () => {
    expect(condSql(cond({ column: "status", value: "1" }), q, t)).toBe(
      "`status` = 1"
    );
    expect(condSql(cond({ column: "qty", value: "-3.5" }), q, t)).toBe(
      "`qty` = -3.5"
    );
  });

  it("文字列の列は、数字だけの値でも引用符で囲む", () => {
    // 見た目で決めていたころは `code` = 0123 になり、
    // PostgreSQLでは型が合わずエラーになっていた
    expect(condSql(cond({ column: "code", value: "0123" }), q, t)).toBe(
      "`code` = '0123'"
    );
    expect(condSql(cond({ column: "name", value: "123" }), q, t)).toBe(
      "`name` = '123'"
    );
  });

  it("日付の列も引用符で囲む", () => {
    expect(condSql(cond({ column: "order_date", value: "2026-09-02" }), q, t)).toBe(
      "`order_date` = '2026-09-02'"
    );
  });

  it("文字列の列では true / null も文字として扱う", () => {
    expect(condSql(cond({ column: "memo", value: "null" }), q, t)).toBe(
      "`memo` = 'null'"
    );
  });

  it("真偽値の列は TRUE / FALSE で書く", () => {
    expect(condSql(cond({ column: "is_active", value: "true" }), q, t)).toBe(
      "`is_active` = TRUE"
    );
    expect(condSql(cond({ column: "is_active", value: "False" }), q, t)).toBe(
      "`is_active` = FALSE"
    );
    // MySQLの 0/1 もそのまま渡す
    expect(condSql(cond({ column: "is_active", value: "1" }), q, t)).toBe(
      "`is_active` = 1"
    );
  });

  it("数値の列に数でない値を入れても、文のかたちは崩さない", () => {
    expect(condSql(cond({ column: "status", value: "あ" }), q, t)).toBe(
      "`status` = 'あ'"
    );
  });

  it("型が空の列 (SQLiteなど) は値の見た目で決める", () => {
    expect(condSql(cond({ column: "loose", value: "1" }), q, t)).toBe(
      "`loose` = 1"
    );
    expect(condSql(cond({ column: "loose", value: "あ" }), q, t)).toBe(
      "`loose` = 'あ'"
    );
  });

  it("INの中身も列の型に合わせる", () => {
    expect(condSql(cond({ column: "code", op: "in", value: "1, 2" }), q, t)).toBe(
      "`code` IN ('1', '2')"
    );
    expect(
      condSql(cond({ column: "status", op: "in", value: "1, 2" }), q, t)
    ).toBe("`status` IN (1, 2)");
  });

  it("LIKEは型に関わらず引用符で囲む", () => {
    expect(
      condSql(cond({ column: "status", op: "contains", value: "1" }), q, t)
    ).toBe("`status` LIKE '%1%'");
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

  it("列ごとに型を見て書き分ける", () => {
    expect(
      buildWhere(
        [
          cond({ column: "status", value: "1" }),
          cond({ column: "code", value: "0123" }),
        ],
        q,
        t
      )
    ).toBe("`status` = 1 AND `code` = '0123'");
  });
});
