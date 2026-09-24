import { describe, expect, it } from "vitest";
import { toOnNewline } from "./sqlOnClause";

describe("toOnNewline", () => {
  it("JOINと同じ行のONを次の行へ出す", () => {
    expect(toOnNewline("  JOIN b ON a.id = b.id", "  ")).toBe(
      ["  JOIN b", "  ON", "    a.id = b.id"].join("\n")
    );
  });

  it("続く AND / OR も一段下げる", () => {
    const src = ["  JOIN b ON a.id = b.id", "  AND a.k = b.k"].join("\n");
    expect(toOnNewline(src, "  ")).toBe(
      ["  JOIN b", "  ON", "    a.id = b.id", "    AND a.k = b.k"].join("\n")
    );
  });

  /*
   * 相手が副問い合わせのときは、整形器が「) tod ON …」の形で出す。
   * JOINのある行だけを見ていると、この結合だけONが同じ行に残り、
   * 他の結合と並びが揃わない
   */
  it("副問い合わせを閉じた行のONも次の行へ出す", () => {
    expect(toOnNewline("  ) tod ON tod.no = tso.no", "  ")).toBe(
      ["  ) tod", "  ON", "    tod.no = tso.no"].join("\n")
    );
  });

  it("別名の書き方が違っても同じように出す", () => {
    for (const head of [") tod", ") AS tod", ") `tod`", ")"]) {
      expect(toOnNewline(`  ${head} ON x = y`, "  ")).toBe(
        [`  ${head}`, "  ON", "    x = y"].join("\n")
      );
    }
  });

  it("ONが無い行はそのまま", () => {
    const src = ["  JOIN b USING (id)", "  ) tod", "  WHERE a = 1"].join("\n");
    expect(toOnNewline(src, "  ")).toBe(src);
  });
});
