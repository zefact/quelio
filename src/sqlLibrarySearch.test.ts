import { describe, expect, it } from "vitest";
import {
  filterHistory,
  filterSaved,
  matchesTerms,
  previewLine,
  searchTerms,
} from "./sqlLibrarySearch";
import type { SavedSqlEntry, SavedSqlStore, SqlHistoryEntry } from "./types";

const hist = (sql: string): SqlHistoryEntry => ({ sql, executedAtMs: 0 });

const item = (
  id: string,
  name: string,
  folder: string,
  sql: string,
): SavedSqlEntry => ({ id, name, folder, sql, updatedAtMs: 0 });

describe("searchTerms", () => {
  it("空白で区切って小文字にする", () => {
    expect(searchTerms("  SELECT  users ")).toEqual(["select", "users"]);
  });

  it("空なら語は無い", () => {
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("matchesTerms", () => {
  it("語をすべて含むときだけ当たり", () => {
    expect(matchesTerms("SELECT * FROM users", ["select", "users"])).toBe(true);
    expect(matchesTerms("SELECT * FROM users", ["select", "orders"])).toBe(
      false,
    );
  });

  it("語が無ければ全部当たり", () => {
    expect(matchesTerms("なんでも", [])).toBe(true);
  });

  it("大文字小文字は区別しない", () => {
    expect(matchesTerms("SELECT", ["select"])).toBe(true);
  });

  it("日本語も探せる", () => {
    expect(matchesTerms("-- 売上の集計", ["売上"])).toBe(true);
  });
});

describe("filterHistory", () => {
  const entries = [
    hist("SELECT * FROM users"),
    hist("SELECT * FROM orders"),
    hist("UPDATE users SET name = 'a'"),
  ];

  it("SQLの中身で絞り込む", () => {
    expect(filterHistory(entries, "orders").map((h) => h.sql)).toEqual([
      "SELECT * FROM orders",
    ]);
  });

  it("語をすべて含むものだけ残す", () => {
    expect(filterHistory(entries, "users update")).toHaveLength(1);
  });

  it("空なら元のまま返す", () => {
    expect(filterHistory(entries, "  ")).toBe(entries);
  });

  it("見つからなければ空", () => {
    expect(filterHistory(entries, "delete")).toEqual([]);
  });
});

describe("filterSaved", () => {
  const store: SavedSqlStore = {
    folders: ["売上"],
    items: [
      item("a", "日次集計", "売上", "SELECT sum(amount) FROM orders"),
      item("b", "利用者一覧", "", "SELECT * FROM users"),
      item("c", "棚卸", "在庫", "SELECT * FROM stocks"),
    ],
    order: ["f:売上", "i:a", "i:c", "i:b"],
  };

  it("名前で探せる", () => {
    expect(filterSaved(store, "集計").map((e) => e.id)).toEqual(["a"]);
  });

  it("フォルダ名でも探せる", () => {
    expect(filterSaved(store, "在庫").map((e) => e.id)).toEqual(["c"]);
  });

  it("SQLの中身でも探せる", () => {
    expect(filterSaved(store, "users").map((e) => e.id)).toEqual(["b"]);
  });

  it("表示順のまま並べる", () => {
    expect(filterSaved(store, "select").map((e) => e.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("並びに入っていないものも落とさない", () => {
    const odd: SavedSqlStore = { ...store, order: ["i:b"] };
    expect(filterSaved(odd, "select").map((e) => e.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("空なら何も返さない (ツリーをそのまま出すため)", () => {
    expect(filterSaved(store, "")).toEqual([]);
  });
});

describe("previewLine", () => {
  it("改行や連続する空白は1つにまとめる", () => {
    expect(previewLine("SELECT\n  *\nFROM t", "")).toBe("SELECT * FROM t");
  });

  it("長いSQLは先頭だけ出す", () => {
    const long = "a".repeat(200);
    const got = previewLine(long, "");
    expect(got).toHaveLength(81);
    expect(got.endsWith("…")).toBe(true);
  });

  it("探している語が先頭近くなら、そのまま頭から出す", () => {
    const sql = `SELECT * FROM users WHERE ${"x".repeat(200)}`;
    expect(previewLine(sql, "users").startsWith("SELECT")).toBe(true);
  });

  it("探している語が遠いときは、その手前から切り出す", () => {
    const sql = `${"x".repeat(300)} FROM orders`;
    const got = previewLine(sql, "orders");
    expect(got.startsWith("…")).toBe(true);
    expect(got).toContain("orders");
  });
});
