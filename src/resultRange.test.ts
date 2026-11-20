import { describe, expect, it } from "vitest";
import {
  clockOf,
  pagerLabel,
  rangeText,
  resultMetaText,
  showPager,
} from "./resultRange";
import { QUERY_PAGE_SIZE } from "./types";

describe("rangeText", () => {
  it("ページの表は何行目から何行目かを出す", () => {
    expect(rangeText({ kind: "page", offset: 0, rows: 1000 })).toBe(
      "1〜1,000行目"
    );
    expect(rangeText({ kind: "page", offset: 1000, rows: 5 })).toBe(
      "1,001〜1,005行目"
    );
  });

  it("0行なら範囲ではなく0行と出す", () => {
    expect(rangeText({ kind: "page", offset: 0, rows: 0 })).toBe("0行");
  });

  it("ページ送りできない表は行数と、先頭だけかどうか", () => {
    expect(rangeText({ kind: "head", rows: 1200, more: false })).toBe("1,200行");
    expect(rangeText({ kind: "head", rows: 1000, more: true })).toBe(
      "1,000行 (先頭のみ表示)"
    );
  });

  it("表にならない文は影響した行数", () => {
    expect(rangeText({ kind: "exec", affected: 3 })).toBe("3行に影響");
    expect(rangeText({ kind: "exec", affected: 12345 })).toBe("12,345行に影響");
  });
});

describe("resultMetaText", () => {
  it("件数と時間をつなぐ", () => {
    expect(resultMetaText({ kind: "page", offset: 0, rows: 2 }, 15)).toBe(
      "1〜2行目 — 15ms"
    );
  });

  it("取得時刻があれば、いつの内容かを添える", () => {
    const at = new Date(2024, 0, 2, 9, 5, 3).getTime();
    expect(resultMetaText({ kind: "page", offset: 0, rows: 0 }, 8, at)).toBe(
      "0行 — 8ms — 09:05:03 時点"
    );
  });
});

describe("clockOf", () => {
  it("時:分:秒を2桁ずつで出す", () => {
    expect(clockOf(new Date(2024, 0, 2, 23, 0, 9).getTime())).toBe("23:00:09");
  });
});

describe("pagerLabel", () => {
  it("1ページの行数は定数から作る", () => {
    const n = QUERY_PAGE_SIZE.toLocaleString();
    expect(pagerLabel("prev")).toBe(`前の${n}行`);
    expect(pagerLabel("next")).toBe(`次の${n}行`);
  });
});

describe("showPager", () => {
  it("1ページに収まっていれば出さない", () => {
    expect(showPager(0, false)).toBe(false);
  });

  it("続きがあるか、2ページ目以降なら出す", () => {
    expect(showPager(0, true)).toBe(true);
    expect(showPager(1000, false)).toBe(true);
  });
});
