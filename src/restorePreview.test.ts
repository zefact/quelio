import { describe, expect, it } from "vitest";
import { fileNameOf, overwrittenNames, restoreCounts } from "./restorePreview";

describe("restoreCounts", () => {
  it("追加と上書きの件数を1行にする", () => {
    expect(restoreCounts({ added: 2, updated: 0 })).toBe("追加2件 / 上書き0件");
  });
});

describe("overwrittenNames", () => {
  it("少なければ全部並べる", () => {
    expect(overwrittenNames(["受注", "在庫"])).toBe("「受注」「在庫」");
  });

  it("無ければ空文字", () => {
    expect(overwrittenNames([])).toBe("");
  });

  it("多ければ先頭だけ出して残りを数で書く", () => {
    expect(overwrittenNames(["a", "b", "c", "d"], 2)).toBe("「a」「b」 ほか2件");
  });

  it("残りが1件だけなら全部並べる", () => {
    expect(overwrittenNames(["a", "b", "c"], 2)).toBe("「a」「b」「c」");
  });

  it("名前が空のものは (名前なし) と出す", () => {
    expect(overwrittenNames([""])).toBe("「(名前なし)」");
  });
});

describe("fileNameOf", () => {
  it("ファイル名だけを取り出す", () => {
    expect(fileNameOf("/Users/me/quelio_er_diagrams_20261119.json")).toBe(
      "quelio_er_diagrams_20261119.json"
    );
    expect(fileNameOf("C:\\backup\\a.json")).toBe("a.json");
    expect(fileNameOf("a.json")).toBe("a.json");
  });
});
