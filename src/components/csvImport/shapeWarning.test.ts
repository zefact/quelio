import { describe, expect, it } from "vitest";

import { EXAMPLE_LIMIT, examples, hasMismatch, shapeWarningText } from "./shapeWarning";
import type { ShapeReport } from "../../types";

function report(over: Partial<ShapeReport> = {}): ShapeReport {
  return {
    headerWidth: 38,
    mismatches: [],
    mismatchCount: 0,
    rows: 20000,
    truncated: false,
    cancelled: false,
    elapsedMs: 120,
    ...over,
  };
}

describe("hasMismatch", () => {
  it("1件でもあれば確認を出す", () => {
    expect(hasMismatch(report())).toBe(false);
    expect(
      hasMismatch(
        report({
          mismatchCount: 1,
          mismatches: [{ lineNo: 5, width: 3 }],
        })
      )
    ).toBe(true);
  });
});

describe("examples", () => {
  it("行番号と列数を並べる", () => {
    const got = examples(
      report({
        mismatchCount: 2,
        mismatches: [
          { lineNo: 1234, width: 38 },
          { lineNo: 5678, width: 41 },
        ],
      })
    );
    expect(got).toBe("1,234行目 = 38列、5,678行目 = 41列");
  });

  it("上限を超えたら「…」で締める", () => {
    const mismatches = Array.from({ length: EXAMPLE_LIMIT + 2 }, (_, i) => ({
      lineNo: i + 1,
      width: 9,
    }));
    const got = examples(report({ mismatchCount: mismatches.length, mismatches }));
    expect(got.split("、")).toHaveLength(EXAMPLE_LIMIT + 1);
    expect(got.endsWith("…")).toBe(true);
  });

  it("例に出ていない分も件数には入る", () => {
    // 20件までしか返らないが、総数は多い
    const mismatches = [{ lineNo: 10, width: 2 }];
    const got = examples(report({ mismatchCount: 500, mismatches }));
    expect(got).toBe("10行目 = 2列、…");
  });
});

describe("shapeWarningText", () => {
  it("件数と例と、どう取り込むかを書く", () => {
    const got = shapeWarningText(
      report({
        mismatchCount: 2,
        mismatches: [
          { lineNo: 1234, width: 38 },
          { lineNo: 5678, width: 41 },
        ],
      })
    );
    expect(got).toContain("2件あります");
    expect(got).toContain("1,234行目 = 38列");
    expect(got).toContain("足りない列は空、余分な列は無視して取り込みます");
    expect(got).toContain("クォートされていない可能性があります");
    expect(got.endsWith("続けますか?")).toBe(true);
    expect(got).not.toContain("途中までしか");
  });

  it("桁区切りを入れる", () => {
    const got = shapeWarningText(
      report({ mismatchCount: 12345, mismatches: [{ lineNo: 7, width: 1 }] })
    );
    expect(got).toContain("12,345件あります");
  });

  it("打ち切ったときはそう書く", () => {
    const got = shapeWarningText(
      report({
        mismatchCount: 1,
        mismatches: [{ lineNo: 7, width: 1 }],
        truncated: true,
      })
    );
    expect(got).toContain("途中までしか確かめていません");
  });
});
