import { describe, expect, it } from "vitest";
import { autoTitle } from "./sheetTitle";

describe("autoTitle", () => {
  it("SQLの1行目を見出しにする", () => {
    expect(autoTitle("select * from users")).toBe("select * from users");
  });

  it("空なら新規", () => {
    expect(autoTitle("   \n\n")).toBe("新規");
  });

  it("先頭のコメントを見出しにする", () => {
    expect(autoTitle("-- 月次の売上\nselect 1")).toBe("月次の売上");
  });

  it("#のコメントも見出しにする (MySQL)", () => {
    expect(autoTitle("# 月次の売上\nselect 1")).toBe("月次の売上");
  });

  it("ブロックコメントも見出しにする", () => {
    expect(autoTitle("/* 月次の売上 */\nselect 1")).toBe("月次の売上");
  });

  it("区切り線だけの行は飛ばす", () => {
    expect(autoTitle("-- ------------\n-- 月次の売上\nselect 1")).toBe(
      "月次の売上"
    );
  });

  it("コメントが飾りだけならSQLを見出しにする", () => {
    expect(autoTitle("-- =====\nselect 1")).toBe("select 1");
  });

  it("長い見出しは切る", () => {
    expect(autoTitle(`-- ${"あ".repeat(30)}`)).toBe(`${"あ".repeat(24)}…`);
  });

  it("空行を飛ばして見出しを探す", () => {
    expect(autoTitle("\n\n  -- 集計\nselect 1")).toBe("集計");
  });
});
