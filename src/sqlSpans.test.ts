import { describe, expect, it } from "vitest";
import { spanAt, spansOf } from "./sqlSpans";

const SQL = "SELECT 1;\n\n-- メモ\nUPDATE t SET a = 1;\nSELECT 1;\n";
const STMTS = ["SELECT 1", "-- メモ\nUPDATE t SET a = 1", "SELECT 1"];

describe("spansOf", () => {
  it("文の位置を順番に探す", () => {
    const spans = spansOf(SQL, STMTS);
    expect(spans.map((s) => s.text)).toEqual(STMTS);
    expect(SQL.slice(spans[0].from, spans[0].to)).toBe("SELECT 1");
    expect(SQL.slice(spans[1].from, spans[1].to)).toBe(STMTS[1]);
  });

  it("同じ文が繰り返されても取り違えない", () => {
    const spans = spansOf(SQL, STMTS);
    // 3つ目の SELECT 1 は、1つ目より後ろにある
    expect(spans[2].from).toBeGreaterThan(spans[0].to);
  });

  it("手元のテキストと合わない文は飛ばす", () => {
    expect(spansOf("SELECT 1", ["SELECT 2"])).toEqual([]);
  });

  it("日本語を含んでいても位置がずれない", () => {
    const sql = "SELECT '日本語' AS a;\nSELECT 2;";
    const spans = spansOf(sql, ["SELECT '日本語' AS a", "SELECT 2"]);
    expect(sql.slice(spans[1].from, spans[1].to)).toBe("SELECT 2");
  });
});

describe("spanAt", () => {
  const spans = spansOf(SQL, STMTS);

  it("文の中にいればその文", () => {
    expect(spanAt(spans, SQL.indexOf("UPDATE") + 3)?.text).toBe(STMTS[1]);
  });

  it("文の末尾に触れていてもその文", () => {
    expect(spanAt(spans, spans[0].to)?.text).toBe("SELECT 1");
  });

  it("文と文の間なら、直前の文", () => {
    // 1つ目のセミコロンの直後 (空行の中)
    expect(spanAt(spans, spans[0].to + 2)?.text).toBe("SELECT 1");
  });

  it("先頭より前なら最初の文", () => {
    expect(spanAt(spansOf("\n\nSELECT 1", ["SELECT 1"]), 0)?.text).toBe(
      "SELECT 1"
    );
  });

  it("文が無ければ null", () => {
    expect(spanAt([], 0)).toBeNull();
  });
});
