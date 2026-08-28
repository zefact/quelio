import { describe, expect, it } from "vitest";
import { formatSql, toLeadingCommas } from "./sqlFormat";

describe("formatSql", () => {
  it("パラメータを含むSQLを整形できる", () => {
    /*
     * 指定を入れる前は、MySQL・SQLiteで `:name` が構文エラーになっていた。
     * パラメータ入りのSQLは整形できない、という状態だった
     */
    for (const db of ["mysql", "postgresql", "sqlite"] as const) {
      const out = formatSql("select * from t where a = :id and b = @nm", db);
      expect(out, db).toContain(":id");
      expect(out, db).toContain("@nm");
      // 名前が割られていないこと (`@ nm` になると壊れる)
      expect(out, db).not.toMatch(/[:@]\s+\w/);
    }
  });

  it("文字列の中のコロンはパラメータにしない", () => {
    const out = formatSql("select ':a' as memo, :a from t", "mysql");
    expect(out).toContain("':a'");
    expect(out).toContain(":a");
  });

  it("キーワードを大文字にして字下げする", () => {
    const out = formatSql("select a from t where b = 1", "mysql");
    expect(out.split("\n")[0]).toBe("SELECT");
    expect(out).toContain("FROM");
    expect(out).toContain("WHERE");
  });

  it("MySQLのREPLACE関数を文と取り違えない", () => {
    // REPLACE INTO と読まれると、関数なのに改行が入ってしまう
    const out = formatSql("select replace(a, 'x', 'y') from t", "mysql");
    expect(out).toContain("REPLACE(");
    expect(out).not.toMatch(/REPLACE\s*\n/);
  });

  it("整形できないSQLは例外にする", () => {
    // 閉じていない引用符など (呼び出し側でエラーを出す)
    expect(() => formatSql("select ''' from", "mysql")).toThrow();
  });
});

describe("toLeadingCommas", () => {
  it("行末のカンマを次の行の先頭へ移す", () => {
    expect(toLeadingCommas("  a,\n  b,\n  c")).toBe("  a\n  , b\n  , c");
  });

  it("空行はまたいで移す", () => {
    expect(toLeadingCommas("  a,\n\n  b")).toBe("  a\n\n  , b");
  });

  it("次の行が無ければそのまま", () => {
    expect(toLeadingCommas("  a,")).toBe("  a,");
  });
});
