import { describe, expect, it } from "vitest";
import { BLANK, activeGuide, fillBlanks, indentDepth } from "./sqlIndentGuides";

describe("indentDepth", () => {
  it("空白の数を段に直す", () => {
    expect(indentDepth("SELECT", 2, 4)).toBe(0);
    expect(indentDepth("  id", 2, 4)).toBe(1);
    expect(indentDepth("    id", 2, 4)).toBe(2);
    expect(indentDepth("    id", 4, 4)).toBe(1);
  });

  it("半端な字下げは切り捨てる", () => {
    expect(indentDepth("   id", 2, 4)).toBe(1);
  });

  it("タブは次の桁位置まで進む", () => {
    expect(indentDepth("\tid", 4, 4)).toBe(1);
    expect(indentDepth("\t\tid", 4, 4)).toBe(2);
    // 空白2つのあとのタブは、4桁目まで進んで1段ぶん
    expect(indentDepth("  \tid", 4, 4)).toBe(1);
  });

  it("空白だけの行は決められない", () => {
    expect(indentDepth("", 2, 4)).toBe(BLANK);
    expect(indentDepth("    ", 2, 4)).toBe(BLANK);
  });
});

describe("fillBlanks", () => {
  it("空行は前後の浅いほうに合わせる", () => {
    expect(fillBlanks([1, BLANK, 2])).toEqual([1, 1, 2]);
    expect(fillBlanks([2, BLANK, 1])).toEqual([2, 1, 1]);
  });

  it("続いた空行もまとめて埋める", () => {
    expect(fillBlanks([2, BLANK, BLANK, 2])).toEqual([2, 2, 2, 2]);
  });

  it("先頭と末尾の空行には線を引かない", () => {
    expect(fillBlanks([BLANK, 2])).toEqual([0, 2]);
    expect(fillBlanks([2, BLANK])).toEqual([2, 0]);
    expect(fillBlanks([BLANK])).toEqual([0]);
  });

  it("空行が無ければそのまま", () => {
    expect(fillBlanks([0, 1, 2, 1])).toEqual([0, 1, 2, 1]);
  });
});

describe("activeGuide", () => {
  /*
   * 0 SELECT      0
   * 1   CASE      1
   * 2     WHEN a  2
   * 3     ELSE b  2
   * 4   END       1
   * 5 FROM t      0
   */
  const nested = [0, 1, 2, 2, 1, 0];

  it("中身の行では、その行が入っているまとまりの線", () => {
    expect(activeGuide(nested, 2)).toEqual({ at: 1, from: 2, to: 3 });
    expect(activeGuide(nested, 3)).toEqual({ at: 1, from: 2, to: 3 });
  });

  it("まとまりの見出しにいるときは、中身のほうの線", () => {
    // CASE の行 (次から深くなる) では、CASEの中身の線を選ぶ
    expect(activeGuide(nested, 1)).toEqual({ at: 1, from: 2, to: 3 });
  });

  it("外側の行では外側の線", () => {
    // END は深さ1で、次が浅いので、SELECTの中身の線
    expect(activeGuide(nested, 4)).toEqual({ at: 0, from: 1, to: 4 });
    // SELECT は見出しなので、その中身ぜんぶ
    expect(activeGuide(nested, 0)).toEqual({ at: 0, from: 1, to: 4 });
  });

  it("字下げの無いところでは線を濃くしない", () => {
    expect(activeGuide(nested, 5)).toBeNull();
    expect(activeGuide([0, 0, 0], 1)).toBeNull();
  });

  it("行の外を指されても落ちない", () => {
    expect(activeGuide(nested, 99)).toBeNull();
  });

  it("空行をはさんでも同じまとまりとして続く", () => {
    // fillBlanks を通したあとの深さを渡す
    expect(activeGuide([0, 1, 1, 1, 0], 3)).toEqual({ at: 0, from: 1, to: 3 });
  });
});
