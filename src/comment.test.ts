import { describe, expect, it } from "vitest";
import { parseComment } from "./comment";

describe("parseComment", () => {
  it("区切り文字で論理名と補足に分ける", () => {
    expect(parseComment("名前（表示用）", "（")).toEqual(["名前", "表示用"]);
    expect(parseComment("名前(表示用)", "(")).toEqual(["名前", "表示用"]);
    expect(parseComment("名前【表示用】", "【")).toEqual(["名前", "表示用"]);
  });

  it("区切りが無ければ全部を論理名にする", () => {
    expect(parseComment("名前", "（")).toEqual(["名前", ""]);
    expect(parseComment("", "（")).toEqual(["", ""]);
  });

  it("区切りの指定が空なら分けない", () => {
    expect(parseComment("名前（表示用）", "")).toEqual(["名前（表示用）", ""]);
  });

  it("閉じ括弧が無くても壊れない", () => {
    expect(parseComment("名前（表示用", "（")).toEqual(["名前", "表示用"]);
  });

  it("最初の区切りだけで分ける (補足の中の括弧は残す)", () => {
    expect(parseComment("名前（表示用（内側））", "（")).toEqual([
      "名前",
      "表示用（内側）",
    ]);
  });

  it("前後の空白は落とす", () => {
    expect(parseComment(" 名前 （ 表示用 ）", "（")).toEqual(["名前", "表示用"]);
  });
});
