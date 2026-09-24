import { describe, expect, it } from "vitest";
import { commentOnlyLines, toLeadingCommas } from "./sqlLeadingComma";

describe("commentOnlyLines", () => {
  it("行コメントとブロックコメントを見分ける", () => {
    const lines = [
      "  a",
      "  -- , b",
      "  # mysqlのコメント",
      "  /* 途中まで",
      "     続き */",
      "  c",
    ];
    expect(commentOnlyLines(lines)).toEqual([
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it("ブロックコメントの後ろに中身がある行は本体として扱う", () => {
    expect(commentOnlyLines(["/* x */ a,"])).toEqual([false]);
    expect(commentOnlyLines(["/* x", "y */ a,"])).toEqual([true, false]);
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

  /*
   * コメント行の先頭に付けると、カンマごとコメントに飲まれて
   * SQLが壊れる (整形しただけで実行できないSQLになっていた)
   */
  it("コメント行は飛ばして、その先の列へ移す", () => {
    expect(toLeadingCommas("  a,\n  -- 略\n  b")).toBe("  a\n  -- 略\n  , b");
    expect(toLeadingCommas("  a,\n  /* 略 */\n  b")).toBe(
      "  a\n  /* 略 */\n  , b"
    );
  });

  it("コメント行の中のカンマは動かさない", () => {
    expect(toLeadingCommas("  -- , b\n  c")).toBe("  -- , b\n  c");
  });

  /*
   * 整形器は、コメントに挟まれたカンマを単独の行に出す。
   * カンマを移したあとに空行が残ると、列の並びが途切れて見える
   */
  it("カンマだけの行は、移したあと空行として残さない", () => {
    expect(toLeadingCommas("  a\n  -- 略\n,\n  b")).toBe(
      "  a\n  -- 略\n  , b"
    );
  });
});
