import { describe, expect, it } from "vitest";
import { clipIndex, clippedHead, clippedRowKeys } from "./cellValue";
import type { ClippedCell } from "./types";

const at = (row: number, col: number, head = 1000, total = 5000): ClippedCell => ({
  row,
  col,
  head,
  total,
});

describe("clipIndex", () => {
  it("位置から長さを引ける", () => {
    const f = clipIndex([at(0, 2), at(3, 1, 1000, 12345)]);
    expect(f(0, 2)).toEqual({ head: 1000, total: 5000 });
    expect(f(3, 1)).toEqual({ head: 1000, total: 12345 });
  });

  it("切り詰めていないセルはnull", () => {
    const f = clipIndex([at(0, 2)]);
    expect(f(0, 1)).toBeNull();
    expect(f(1, 2)).toBeNull();
  });

  it("印が無ければ常にnull", () => {
    expect(clipIndex(undefined)(0, 0)).toBeNull();
    expect(clipIndex([])(0, 0)).toBeNull();
  });

  it("値の文言では判定しない", () => {
    /*
     * 本物の値がたまたま注記と同じ形をしていても、
     * 位置に無ければ切り詰めとは扱わない
     * (以前は「… (全N文字)」を正規表現で読み戻していた)
     */
    expect(clipIndex([])(0, 0)).toBeNull();
  });
});

describe("clippedRowKeys", () => {
  it("切り詰めのある行だけを返す", () => {
    expect(clippedRowKeys([at(0, 1), at(0, 2), at(4, 0)])).toEqual(
      new Set(["0", "4"])
    );
    expect(clippedRowKeys(undefined).size).toBe(0);
  });
});

describe("clippedHead", () => {
  it("注記を外して先頭だけを返す", () => {
    const value = "あ".repeat(5) + "… (全5000文字)";
    expect(clippedHead(value, { head: 5, total: 5000 })).toBe("あ".repeat(5));
  });

  it("切り詰めていなければそのまま", () => {
    expect(clippedHead("そのまま", null)).toBe("そのまま");
  });

  it("サロゲートペアも1文字として数える", () => {
    // Rust側は文字 (コードポイント) で数えるので、JS側も合わせる
    const value = "𩸽".repeat(3) + "… (全9文字)";
    expect(clippedHead(value, { head: 3, total: 9 })).toBe("𩸽".repeat(3));
  });
});
