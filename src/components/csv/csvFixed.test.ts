import { describe, expect, it } from "vitest";
import { appliedLayoutName, sameLayout } from "./csvFixed";
import type { CsvFixedLayout, CsvSavedLayout } from "../../types";

/** 試しやすいように、幅だけ指定して桁設定を作る */
function layout(widths: number[], fix: Partial<CsvFixedLayout> = {}): CsvFixedLayout {
  return {
    unit: "byte",
    trim: true,
    newline: true,
    header: [],
    trailer: [],
    key: null,
    columns: widths.map((width) => ({
      width,
      align: "left" as const,
      pad: " ",
      name: "",
    })),
    ...fix,
  };
}

function saved(name: string, l: CsvFixedLayout): CsvSavedLayout {
  return { name, layout: l, updatedAtMs: 0 };
}

describe("sameLayout", () => {
  it("同じ中身なら同じとみなす", () => {
    expect(sameLayout(layout([10, 8]), layout([10, 8]))).toBe(true);
  });

  it("桁の幅が違えば別もの", () => {
    expect(sameLayout(layout([10, 8]), layout([10, 9]))).toBe(false);
  });

  it("桁の数が違えば別もの", () => {
    expect(sameLayout(layout([10, 8]), layout([10, 8, 4]))).toBe(false);
  });

  it("桁幅の単位が違えば別もの", () => {
    expect(sameLayout(layout([10]), layout([10], { unit: "char" }))).toBe(false);
  });

  it("埋め文字を落とすかどうかが違えば別もの", () => {
    expect(sameLayout(layout([10]), layout([10], { trim: false }))).toBe(false);
  });

  it("改行で区切るかどうかが違えば別もの", () => {
    expect(sameLayout(layout([10]), layout([10], { newline: false }))).toBe(
      false
    );
  });

  it("ヘッダ行の桁が違えば別もの", () => {
    const withHead = layout([10], {
      header: [{ width: 4, align: "left" as const, pad: " ", name: "" }],
    });
    expect(sameLayout(layout([10]), withHead)).toBe(false);
  });

  it("トレーラ行の桁が違えば別もの", () => {
    const withTail = layout([10], {
      trailer: [{ width: 4, align: "left" as const, pad: " ", name: "" }],
    });
    expect(sameLayout(layout([10]), withTail)).toBe(false);
  });

  it("種別の見分け方が違えば別もの", () => {
    const keyed = layout([10], {
      key: { at: 0, len: 1, header: "A" },
    });
    expect(sameLayout(layout([10]), keyed)).toBe(false);
    expect(
      sameLayout(keyed, layout([10], { key: { at: 0, len: 1, header: "B" } }))
    ).toBe(false);
  });

  it("寄せが違えば別もの", () => {
    const right = layout([10]);
    right.columns[0].align = "right";
    expect(sameLayout(layout([10]), right)).toBe(false);
  });

  it("埋め文字が違えば別もの", () => {
    const zero = layout([10]);
    zero.columns[0].pad = "0";
    expect(sameLayout(layout([10]), zero)).toBe(false);
  });

  it("項目名が違えば別もの", () => {
    const named = layout([10]);
    named.columns[0].name = "伝票番号";
    expect(sameLayout(layout([10]), named)).toBe(false);
  });

  it("固定長で開いていなければ (null) 何とも一致しない", () => {
    expect(sameLayout(null, layout([10]))).toBe(false);
    expect(sameLayout(layout([10]), null)).toBe(false);
  });
});

describe("appliedLayoutName", () => {
  const list = [saved("売上伝票", layout([10, 8])), saved("得意先", layout([4, 30]))];

  it("同じ中身のお気に入りの名前を返す", () => {
    expect(appliedLayoutName(list, layout([4, 30]))).toBe("得意先");
  });

  it("どれとも違えば名前を返さない", () => {
    expect(appliedLayoutName(list, layout([7]))).toBe(null);
  });

  it("固定長で開いていなければ名前を返さない", () => {
    expect(appliedLayoutName(list, null)).toBe(null);
  });

  it("お気に入りが無ければ名前を返さない", () => {
    expect(appliedLayoutName([], layout([10, 8]))).toBe(null);
  });
});
