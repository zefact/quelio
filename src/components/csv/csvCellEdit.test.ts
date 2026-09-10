import { describe, expect, it } from "vitest";
import { insertNewline, lineCount, lineParts } from "./csvCellEdit";

describe("改行を入れる", () => {
  it("印のところで割る", () => {
    expect(insertNewline("abcd", 2, 2)).toEqual({ text: "ab\ncd", caret: 3 });
  });

  it("選んでいるところは差し替える", () => {
    expect(insertNewline("abcd", 1, 3)).toEqual({ text: "a\nd", caret: 2 });
  });

  it("始めと終わりが逆でも同じ", () => {
    expect(insertNewline("abcd", 3, 1)).toEqual({ text: "a\nd", caret: 2 });
  });

  it("端でも壊れない", () => {
    expect(insertNewline("", 0, 0)).toEqual({ text: "\n", caret: 1 });
    expect(insertNewline("ab", 9, 9)).toEqual({ text: "ab\n", caret: 3 });
    expect(insertNewline("ab", -1, -1)).toEqual({ text: "\nab", caret: 1 });
  });

  it("すでにある改行の中にも入れられる", () => {
    expect(insertNewline("a\nb", 2, 2)).toEqual({ text: "a\n\nb", caret: 3 });
  });
});

describe("行数を数える", () => {
  it("改行の数より1つ多い", () => {
    expect(lineCount("")).toBe(1);
    expect(lineCount("abc")).toBe(1);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("a\nb\n")).toBe(3);
  });

  it("CR や CRLF も1つの改行として数える", () => {
    expect(lineCount("a\r\nb")).toBe(2);
    expect(lineCount("a\rb")).toBe(2);
  });
});

describe("改行で切り分ける", () => {
  it("改行が無ければ1つ", () => {
    expect(lineParts("abc")).toEqual(["abc"]);
    expect(lineParts("")).toEqual([""]);
  });

  it("改行のところで切る", () => {
    expect(lineParts("a\nb\nc")).toEqual(["a", "b", "c"]);
    // 端の改行は空の断片になる (印だけが出る)
    expect(lineParts("\na\n")).toEqual(["", "a", ""]);
  });

  it("CRLF は2つに割らない", () => {
    expect(lineParts("a\r\nb")).toEqual(["a", "b"]);
  });
});
