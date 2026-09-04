import { describe, expect, it } from "vitest";
import { skipHere } from "./sqlFunctionCompletion";

describe("skipHere", () => {
  it("ふつうの場所では出す", () => {
    expect(skipHere("SELECT ")).toBe(false);
    expect(skipHere("SELECT id, ")).toBe(false);
    expect(skipHere("SELECT * FROM t WHERE ")).toBe(false);
    expect(skipHere("SELECT * FROM t GROUP BY ")).toBe(false);
  });

  it("別名の直後では出さない (そこはカラム名)", () => {
    expect(skipHere("SELECT t.")).toBe(true);
    expect(skipHere("SELECT users.")).toBe(true);
  });

  it("FROMやJOINの直後では出さない (そこはテーブル名)", () => {
    expect(skipHere("SELECT * FROM ")).toBe(true);
    expect(skipHere("SELECT * FROM a JOIN ")).toBe(true);
    expect(skipHere("INSERT INTO ")).toBe(true);
    expect(skipHere("UPDATE ")).toBe(true);
  });

  it("FROMのあとに表名を書き終えていれば出す", () => {
    expect(skipHere("SELECT * FROM users WHERE ")).toBe(false);
  });
});
