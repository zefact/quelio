import { describe, expect, it } from "vitest";
import {
  buildCountStatement,
  buildInsertStatement,
  buildSelectStatement,
  buildTableSelect,
  buildTruncateStatement,
  normalizeWhere,
  quoteIdent,
  quoteIdentIfNeeded,
  quoteTable,
  tableKey,
} from "./tableSql";
import type { TableInfo } from "./types";

const t = (name: string, schema?: string): TableInfo => ({
  name,
  schema,
  tableType: "BASE TABLE",
});

describe("quoteIdent", () => {
  it("DBごとの引用符で囲む", () => {
    expect(quoteIdent("mysql", "a")).toBe("`a`");
    expect(quoteIdent("postgresql", "a")).toBe('"a"');
    expect(quoteIdent("sqlite", "a")).toBe('"a"');
  });

  it("引用符を含む名前でも閉じられない (重ねる)", () => {
    expect(quoteIdent("mysql", "a`b")).toBe("`a``b`");
    expect(quoteIdent("postgresql", 'a"b')).toBe('"a""b"');
    // 閉じてSQLを足そうとしても、識別子の中に留まる
    expect(quoteIdent("mysql", "a` , DROP TABLE x -- ")).toBe(
      "`a`` , DROP TABLE x -- `"
    );
  });
});

describe("quoteIdentIfNeeded", () => {
  it("普通の名前は引用しない", () => {
    expect(quoteIdentIfNeeded("mysql", "id")).toBe("id");
    expect(quoteIdentIfNeeded("postgresql", "created_at")).toBe("created_at");
    expect(quoteIdentIfNeeded("sqlite", "user_id2")).toBe("user_id2");
  });

  it("記号・空白・日本語を含む名前は引用する", () => {
    expect(quoteIdentIfNeeded("mysql", "user name")).toBe("`user name`");
    expect(quoteIdentIfNeeded("mysql", "顧客名")).toBe("`顧客名`");
    expect(quoteIdentIfNeeded("postgresql", "a-b")).toBe('"a-b"');
    // 数字始まりも裸では書けない
    expect(quoteIdentIfNeeded("mysql", "1st")).toBe("`1st`");
  });

  it("予約語は引用する", () => {
    expect(quoteIdentIfNeeded("mysql", "order")).toBe("`order`");
    expect(quoteIdentIfNeeded("mysql", "Group")).toBe("`Group`");
    expect(quoteIdentIfNeeded("postgresql", "user")).toBe('"user"');
  });

  it("PostgreSQLは大文字を含むと引用する (裸だと小文字になるため)", () => {
    expect(quoteIdentIfNeeded("postgresql", "userName")).toBe('"userName"');
    // MySQLとSQLiteは裸でも大文字小文字を気にしない
    expect(quoteIdentIfNeeded("mysql", "userName")).toBe("userName");
    expect(quoteIdentIfNeeded("sqlite", "userName")).toBe("userName");
  });

  it("引用したときの中身は quoteIdent と同じ (逃がし方も同じ)", () => {
    expect(quoteIdentIfNeeded("mysql", "a`b")).toBe("`a``b`");
  });
});

describe("quoteTable", () => {
  it("スキーマがあれば付ける", () => {
    expect(quoteTable("postgresql", t("u", "public"))).toBe('"public"."u"');
    expect(quoteTable("mysql", t("u"))).toBe("`u`");
  });
});

describe("tableKey", () => {
  it("スキーマの有無で衝突しないキーを作る", () => {
    expect(tableKey(t("u"))).toBe(".u");
    expect(tableKey(t("u", "public"))).toBe("public.u");
    expect(tableKey(t("u", "s"))).not.toBe(tableKey(t("u")));
  });
});

describe("normalizeWhere", () => {
  it("先頭のWHEREと末尾の;を落とす", () => {
    expect(normalizeWhere("  WHERE id > 10 ;  ")).toBe("id > 10");
    expect(normalizeWhere("where id > 10")).toBe("id > 10");
    expect(normalizeWhere("id > 10")).toBe("id > 10");
    expect(normalizeWhere("   ")).toBe("");
  });

  it("値の中のwhereは消さない", () => {
    expect(normalizeWhere("memo = 'where'")).toBe("memo = 'where'");
  });
});

describe("buildTableSelect", () => {
  it("条件があればWHEREを付ける", () => {
    expect(buildTableSelect("mysql", t("u"), "")).toBe("SELECT * FROM `u`");
    expect(buildTableSelect("mysql", t("u"), "WHERE id = 1")).toBe(
      "SELECT * FROM `u` WHERE id = 1"
    );
  });
});

describe("生成するSQL文", () => {
  it("SELECT文は列を並べる (列が無ければ *)", () => {
    expect(buildSelectStatement("mysql", t("u"), ["id", "name"])).toBe(
      "SELECT\n  `id`,\n  `name`\nFROM `u`;"
    );
    expect(buildSelectStatement("mysql", t("u"), [])).toBe(
      "SELECT\n  *\nFROM `u`;"
    );
  });

  it("INSERT文は値をNULLのひな形にする", () => {
    expect(buildInsertStatement("mysql", t("u"), ["id", "name"])).toBe(
      "INSERT INTO `u` (\n  `id`,\n  `name`\n) VALUES (\n  NULL,\n  NULL\n);"
    );
  });

  it("COUNT文", () => {
    expect(buildCountStatement("postgresql", t("u", "s"))).toBe(
      'SELECT COUNT(*) FROM "s"."u";'
    );
  });

  it("空にするSQLはSQLiteだけDELETE", () => {
    expect(buildTruncateStatement("mysql", t("u"))).toBe(
      "TRUNCATE TABLE `u`;"
    );
    expect(buildTruncateStatement("sqlite", t("u"))).toBe('DELETE FROM "u";');
  });

  it("名前に引用符が入っていてもSQLを足せない", () => {
    const evil = t("u`; DROP TABLE x; -- ");
    expect(buildCountStatement("mysql", evil)).toBe(
      "SELECT COUNT(*) FROM `u``; DROP TABLE x; -- `;"
    );
  });
});
