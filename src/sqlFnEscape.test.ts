import { describe, expect, it } from "vitest";
import {
  escapeKeywordFunctions,
  restoreKeywordFunctions,
} from "./sqlFnEscape";

/** 逃がして戻す、を通しで行う */
function round(sql: string): string {
  const e = escapeKeywordFunctions(sql);
  return restoreKeywordFunctions(e.sql, e.names);
}

describe("文と読まれる名前の逃がし", () => {
  it("関数として書いてあれば逃がす", () => {
    const e = escapeKeywordFunctions("SELECT TRUNCATE(a, 0) FROM t");
    expect(e.sql).toBe("SELECT QUELIO_FN_0(a, 0) FROM t");
    expect(e.names).toEqual(["TRUNCATE"]);
  });

  it("文として書いてあるものは触らない", () => {
    const e = escapeKeywordFunctions("TRUNCATE TABLE t");
    expect(e.sql).toBe("TRUNCATE TABLE t");
    expect(e.names).toEqual([]);
  });

  it("名前と括弧の間に空白があっても逃がす", () => {
    const e = escapeKeywordFunctions("SELECT TRUNCATE (a, 0)");
    expect(e.sql).toBe("SELECT QUELIO_FN_0 (a, 0)");
  });

  it("いくつあっても順に番号を振る", () => {
    const e = escapeKeywordFunctions("SELECT REPLACE(a,'x','y'), TRUNCATE(b,0)");
    expect(e.names).toEqual(["REPLACE", "TRUNCATE"]);
    expect(e.sql).toContain("QUELIO_FN_0(");
    expect(e.sql).toContain("QUELIO_FN_1(");
  });

  it("書いてあったとおりの綴りで戻す", () => {
    expect(round("SELECT truncate(a, 0)")).toBe("SELECT truncate(a, 0)");
    expect(round("SELECT Replace(a, 'x', 'y')")).toBe(
      "SELECT Replace(a, 'x', 'y')"
    );
  });

  it("整形器が括弧の前に入れた空白は詰めて戻す", () => {
    const e = escapeKeywordFunctions("SELECT TRUNCATE(a, 0)");
    // 整形器を通したあとを真似る
    const after = e.sql.replace("QUELIO_FN_0(", "QUELIO_FN_0 (");
    expect(restoreKeywordFunctions(after, e.names)).toBe(
      "SELECT TRUNCATE(a, 0)"
    );
  });
});

describe("触ってはいけないところ", () => {
  it("文字列の中は触らない", () => {
    const sql = "SELECT 'truncate(' AS a, TRUNCATE(b, 0)";
    const e = escapeKeywordFunctions(sql);
    expect(e.sql).toContain("'truncate('");
    expect(e.names).toEqual(["TRUNCATE"]);
    expect(round(sql)).toBe(sql);
  });

  it("引用符を2つ続けて書いた中身も文字列のまま", () => {
    const sql = "SELECT 'it''s replace(' AS a";
    expect(round(sql)).toBe(sql);
    expect(escapeKeywordFunctions(sql).names).toEqual([]);
  });

  it("逆斜線で逃がした引用符も読み飛ばす", () => {
    const sql = "SELECT 'a\\' replace(' AS a";
    expect(escapeKeywordFunctions(sql).names).toEqual([]);
  });

  it("引用符付きの名前は触らない", () => {
    const sql = 'SELECT "replace(" FROM t';
    expect(escapeKeywordFunctions(sql).names).toEqual([]);
    const back = "SELECT `replace(` FROM t";
    expect(escapeKeywordFunctions(back).names).toEqual([]);
  });

  it("コメントの中は触らない", () => {
    const line = "-- truncate(a)\nSELECT 1";
    expect(escapeKeywordFunctions(line).names).toEqual([]);
    const block = "/* truncate(a) */ SELECT 1";
    expect(escapeKeywordFunctions(block).names).toEqual([]);
  });

  it("閉じていない文字列があっても落ちない", () => {
    expect(() => escapeKeywordFunctions("SELECT 'abc")).not.toThrow();
    expect(escapeKeywordFunctions("SELECT 'abc").names).toEqual([]);
  });

  it("名前の一部が同じだけのものは逃がさない", () => {
    expect(escapeKeywordFunctions("SELECT my_truncate(a)").names).toEqual([]);
    expect(escapeKeywordFunctions("SELECT truncated(a)").names).toEqual([]);
  });

  it("逃がすものが無ければ、そのまま返す", () => {
    const sql = "SELECT a FROM t";
    expect(round(sql)).toBe(sql);
  });
});
