import { describe, expect, it } from "vitest";
import { markSegments } from "./csvMark";

/** 見比べやすいように「当たった所」だけを取り出す */
function hits(text: string, query: string, matchCase = false): string[] {
  return markSegments(text, query, matchCase)
    .filter((s) => s.hit)
    .map((s) => s.text);
}

/** 切り分けたものを戻すと元の文字になるか */
function joined(text: string, query: string, matchCase = false): string {
  return markSegments(text, query, matchCase)
    .map((s) => s.text)
    .join("");
}

describe("markSegments", () => {
  it("当たった所を切り出す", () => {
    expect(markSegments("abcabc", "bc", true)).toEqual([
      { text: "a", hit: false },
      { text: "bc", hit: true },
      { text: "a", hit: false },
      { text: "bc", hit: true },
    ]);
  });

  it("切り分けても元の文字は変わらない", () => {
    expect(joined("東京都千代田区", "千代")).toBe("東京都千代田区");
    expect(joined("abcabc", "bc")).toBe("abcabc");
  });

  it("探す語が空なら丸ごと1つだけ返す", () => {
    expect(markSegments("abc", "", false)).toEqual([
      { text: "abc", hit: false },
    ]);
  });

  it("当たらなければ丸ごと1つだけ返す", () => {
    expect(markSegments("abc", "xyz", false)).toEqual([
      { text: "abc", hit: false },
    ]);
  });

  it("空のセルでも落ちない", () => {
    expect(markSegments("", "a", false)).toEqual([{ text: "", hit: false }]);
  });

  it("既定では英字の大小を区別しない", () => {
    expect(hits("Tokyo", "tok")).toEqual(["Tok"]);
  });

  it("区別するときは大小が合ったものだけ当てる", () => {
    expect(hits("Tokyo tokyo", "tok", true)).toEqual(["tok"]);
  });

  it("当たった所は元の大小のまま返す", () => {
    expect(hits("TOKYO", "tokyo")).toEqual(["TOKYO"]);
  });

  it("先頭と末尾に当たっても前後に空の切れ端を作らない", () => {
    expect(markSegments("abc", "abc", true)).toEqual([
      { text: "abc", hit: true },
    ]);
  });

  it("続けて当たるものも1つずつ切り出す", () => {
    expect(hits("aaaa", "aa", true)).toEqual(["aa", "aa"]);
  });

  it("日本語も切り出せる", () => {
    expect(markSegments("山田太郎", "田太", true)).toEqual([
      { text: "山", hit: false },
      { text: "田太", hit: true },
      { text: "郎", hit: false },
    ]);
  });
});
