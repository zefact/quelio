import { describe, expect, it } from "vitest";
import { scanBrackets, scanOptsFor } from "./sqlBrackets";

/** 位置と深さだけを見る (読みやすさのため) */
const at = (sql: string, opts = {}) =>
  scanBrackets(sql, opts).map((b) => `${sql[b.at]}${b.bad ? "!" : b.depth}`);

describe("scanBrackets", () => {
  it("入れ子の深さを数える", () => {
    expect(at("SELECT f(g(x), h(y))")).toEqual([
      "(0",
      "(1",
      ")1",
      "(1",
      ")1",
      ")0",
    ]);
  });

  it("並んだ括弧は同じ深さ", () => {
    expect(at("(a) (b)")).toEqual(["(0", ")0", "(0", ")0"]);
  });

  it("角括弧も数える", () => {
    expect(at("x[1]")).toEqual(["[0", "]0"]);
  });

  it("閉じ忘れと余った閉じ括弧は印を付ける", () => {
    expect(at("SELECT (a")).toEqual(["(!"]);
    expect(at("SELECT a)")).toEqual([")!"]);
    // 種類が合っていないものも相手なし扱い
    expect(at("(a]")).toEqual(["(!", "]!"]);
  });

  it("文字列の中の括弧は数えない", () => {
    expect(at("SELECT '('")).toEqual([]);
    expect(at("SELECT ')' , (1)")).toEqual(["(0", ")0"]);
  });

  it("引用符を2つ並べたものは文字列の途中", () => {
    expect(at("SELECT 'it''s (' , (1)")).toEqual(["(0", ")0"]);
  });

  it("名前を囲む引用符の中も数えない", () => {
    expect(at('SELECT "a(b" FROM t')).toEqual([]);
    expect(at("SELECT `a(b` FROM t")).toEqual([]);
  });

  it("コメントの中は数えない", () => {
    expect(at("SELECT 1 -- (\nFROM t")).toEqual([]);
    expect(at("SELECT /* ( */ (1)")).toEqual(["(0", ")0"]);
    // PostgreSQLのブロックコメントは入れ子になる
    expect(at("/* a /* ( */ ( */ (1)")).toEqual(["(0", ")0"]);
  });

  it("MySQLでは # から行末までがコメント", () => {
    expect(at("SELECT 1 # (\nFROM t", scanOptsFor("mysql"))).toEqual([]);
    // PostgreSQLの # は演算子なので、その先も読む
    expect(at("SELECT 1 # (\n)", scanOptsFor("postgresql"))).toEqual([
      "(0",
      ")0",
    ]);
  });

  it("MySQLでは文字列の中の \\ が次の1文字を逃がす", () => {
    expect(at("SELECT '\\'(' , (1)", scanOptsFor("mysql"))).toEqual([
      "(0",
      ")0",
    ]);
  });

  it("PostgreSQLの $$ の中は数えない", () => {
    const sql = "DO $$ BEGIN ( END $$; SELECT (1)";
    expect(at(sql, scanOptsFor("postgresql"))).toEqual(["(0", ")0"]);
    expect(at("$tag$ ( $tag$ (1)", scanOptsFor("postgresql"))).toEqual([
      "(0",
      ")0",
    ]);
  });

  it("閉じていない引用符があっても止まらない", () => {
    expect(at("SELECT 'abc")).toEqual([]);
    expect(at("SELECT /* abc")).toEqual([]);
  });
});

describe("scanOptsFor", () => {
  it("方言ごとの読み方", () => {
    expect(scanOptsFor("mysql")).toEqual({ hashComment: true, backslash: true });
    expect(scanOptsFor("postgresql")).toEqual({ dollarQuote: true });
    expect(scanOptsFor("sqlite")).toEqual({});
  });
});
