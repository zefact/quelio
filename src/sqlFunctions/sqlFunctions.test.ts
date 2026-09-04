import { describe, expect, it } from "vitest";
import { flatten, functionCount, functionsFor, searchFunctions } from "./index";
import { snippetOf } from "./snippet";
import type { SqlFunc } from "./types";

const func = (name: string, signature: string): SqlFunc => ({
  name,
  signature,
  summary: "",
  example: "",
  result: "",
});

describe("functionsFor", () => {
  it("MySQLとPostgreSQLの関数を返す", () => {
    expect(functionCount("mysql")).toBeGreaterThan(80);
    expect(functionCount("postgresql")).toBeGreaterThan(80);
  });

  it("用意していないDBでは空になる", () => {
    expect(functionsFor("sqlite")).toEqual([]);
    expect(functionsFor("valkey")).toEqual([]);
  });

  it("同じ分類が2つに割れていない", () => {
    for (const db of ["mysql", "postgresql"] as const) {
      const names = functionsFor(db).map((g) => g.category);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("どの関数にも書式と説明と例がある", () => {
    for (const db of ["mysql", "postgresql"] as const) {
      for (const { func: f } of flatten(functionsFor(db))) {
        expect(f.signature, f.name).not.toBe("");
        expect(f.summary, f.name).not.toBe("");
        expect(f.example, f.name).not.toBe("");
        expect(f.result, f.name).not.toBe("");
      }
    }
  });

  it("同じDBの中で名前が重なっていない", () => {
    for (const db of ["mysql", "postgresql"] as const) {
      const names = flatten(functionsFor(db)).map((h) => h.func.name);
      expect(new Set(names).size, db).toBe(names.length);
    }
  });
});

describe("searchFunctions", () => {
  const mysql = functionsFor("mysql");

  it("名前で引ける", () => {
    const hits = searchFunctions(mysql, "date_format");
    expect(hits[0].func.name).toBe("DATE_FORMAT");
  });

  it("大文字小文字は区別しない", () => {
    expect(searchFunctions(mysql, "CONCAT")[0].func.name).toBe("CONCAT");
  });

  it("説明の言葉でも引ける", () => {
    const names = searchFunctions(mysql, "切り捨て").map((h) => h.func.name);
    expect(names).toContain("TRUNCATE");
  });

  it("関連語でも引ける", () => {
    const names = searchFunctions(mysql, "前ゼロ").map((h) => h.func.name);
    expect(names).toContain("LPAD");
  });

  it("空白で区切るとすべて含むものだけになる", () => {
    const hits = searchFunctions(mysql, "json 配列");
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      const text = `${h.func.name} ${h.func.summary} ${h.func.note ?? ""} ${(
        h.func.keywords ?? []
      ).join(" ")}`;
      expect(text.toLowerCase()).toContain("json");
    }
  });

  it("空なら全部返す", () => {
    expect(searchFunctions(mysql, "  ").length).toBe(functionCount("mysql"));
  });

  it("名前が一致したものが上に来る", () => {
    const hits = searchFunctions(mysql, "sum");
    expect(hits[0].func.name).toBe("SUM");
  });
});

describe("snippetOf", () => {
  it("引数を穴にする", () => {
    expect(snippetOf(func("DATE_FORMAT", "DATE_FORMAT(日時, 書式)"))).toBe(
      "DATE_FORMAT(${日時}, ${書式})"
    );
  });

  it("引数が無ければ括弧だけ", () => {
    expect(snippetOf(func("NOW", "NOW()"))).toBe("NOW()");
  });

  it("省略できる引数は穴にしない", () => {
    expect(snippetOf(func("SUBSTRING", "SUBSTRING(文字列, 開始位置 [, 長さ])"))).toBe(
      "SUBSTRING(${文字列}, ${開始位置})"
    );
  });

  it("可変長の ... は穴にしない", () => {
    expect(snippetOf(func("CONCAT", "CONCAT(文字列1, 文字列2, ...)"))).toBe(
      "CONCAT(${文字列1}, ${文字列2})"
    );
  });

  it("入れ子の括弧の中のカンマでは割らない", () => {
    expect(snippetOf(func("F", "F(DECIMAL(桁, 小数), 値)"))).toBe(
      "F(${DECIMAL(桁, 小数)}, ${値})"
    );
  });

  it("関数の形をしていないものは null", () => {
    expect(snippetOf(func("||", "文字列1 || 文字列2"))).toBeNull();
    expect(snippetOf(func("CASE", "CASE WHEN 条件 THEN 値 END"))).toBeNull();
    expect(snippetOf(func("::", "値::型"))).toBeNull();
  });

  it("用意した関数のうち、関数の形のものはすべて穴を作れる", () => {
    for (const db of ["mysql", "postgresql"] as const) {
      for (const { func: f } of flatten(functionsFor(db))) {
        const snippet = snippetOf(f);
        if (snippet === null) continue;
        expect(snippet.startsWith(`${f.name}(`), f.name).toBe(true);
        expect(snippet.endsWith(")"), f.name).toBe(true);
      }
    }
  });
});
