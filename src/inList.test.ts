import { describe, expect, it } from "vitest";
import { splitValues, toInList } from "./inList";

describe("splitValues", () => {
  it("改行で分ける", () => {
    expect(splitValues("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("カンマとタブでも分ける", () => {
    expect(splitValues("a,b\tc")).toEqual(["a", "b", "c"]);
  });

  it("前後の空白と空の行は落とす", () => {
    expect(splitValues("  a  \n\n  b\n  ")).toEqual(["a", "b"]);
  });

  it("もともと付いている引用符は外す", () => {
    expect(splitValues("'a',\"b\",c")).toEqual(["a", "b", "c"]);
  });

  it("値の中の空白は残す", () => {
    expect(splitValues("山田 太郎\n佐藤 花子")).toEqual([
      "山田 太郎",
      "佐藤 花子",
    ]);
  });

  it("同じ値が並んでいてもまとめない", () => {
    expect(splitValues("a\na\nb")).toEqual(["a", "a", "b"]);
  });

  it("何も無ければ空", () => {
    expect(splitValues("   \n\n ")).toEqual([]);
  });
});

describe("toInList", () => {
  it("1行に1つずつ、最後だけカンマ無しで並べる", () => {
    const got = toInList("214234016\n214236030\n214246008", { quote: true });
    expect(got).toBe("'214234016',\n'214236030',\n'214246008'");
  });

  it("引用符なしも選べる (数値の列向け)", () => {
    expect(toInList("1\n2\n3", { quote: false })).toBe("1,\n2,\n3");
  });

  it("値の中の ' は '' にする", () => {
    expect(toInList("O'Brien", { quote: true })).toBe("'O''Brien'");
  });

  it("すでに引用符が付いていても二重にしない", () => {
    expect(toInList("'a'\n'b'", { quote: true })).toBe("'a',\n'b'");
  });

  it("元の字下げを引き継ぐ", () => {
    expect(toInList("    a\n    b", { quote: true })).toBe("    'a',\n    'b'");
  });

  it("1つだけならカンマは付かない", () => {
    expect(toInList("a", { quote: true })).toBe("'a'");
  });

  it("値が無ければ空文字 (呼ぶ側が何もしないと決められる)", () => {
    expect(toInList("\n  \n", { quote: true })).toBe("");
  });

  it("表計算から横に貼っても縦と同じ結果になる", () => {
    const tate = toInList("1\n2\n3", { quote: true });
    const yoko = toInList("1\t2\t3", { quote: true });
    expect(yoko).toBe(tate);
  });
});
