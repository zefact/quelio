import { describe, expect, it } from "vitest";
import type { CsvColumnFilter, CsvFilterValue } from "../../types";
import {
  filterLabel,
  isBlank,
  isFiltered,
  matching,
  needsValue,
  pickedValues,
  usableRules,
  withFilter,
} from "./csvFilter";

const values: CsvFilterValue[] = [
  { text: "Apple", count: 2 },
  { text: "banana", count: 1 },
  { text: "", count: 3 },
];

function filter(fix: Partial<CsvColumnFilter> = {}): CsvColumnFilter {
  return { col: 1, values: null, rules: [], all: true, ...fix };
}

describe("needsValue", () => {
  it("空・空でない以外は値が要る", () => {
    expect(needsValue("contains")).toBe(true);
    expect(needsValue("empty")).toBe(false);
    expect(needsValue("notEmpty")).toBe(false);
  });
});

describe("isBlank", () => {
  it("値も条件も無ければ中身が無い", () => {
    expect(isBlank(filter())).toBe(true);
    expect(isBlank(filter({ values: [] }))).toBe(false);
    expect(isBlank(filter({ rules: [{ kind: "empty", value: "" }] }))).toBe(
      false
    );
  });
});

describe("withFilter", () => {
  it("同じ列は入れ替える (他の列はそのまま)", () => {
    const before = [
      filter({ col: 0, values: ["x"] }),
      filter({ col: 1, values: ["z"] }),
    ];
    const got = withFilter(before, filter({ col: 0, values: ["y"] }));
    expect(got).toEqual([
      filter({ col: 0, values: ["y"] }),
      filter({ col: 1, values: ["z"] }),
    ]);
  });

  it("中身が無くなったものは持たない", () => {
    const before = [filter({ col: 0, values: ["x"] })];
    expect(withFilter(before, filter({ col: 0 }))).toEqual([]);
  });

  it("列の順に並べる", () => {
    const got = withFilter(
      [filter({ col: 2, values: ["x"] })],
      filter({ col: 0, values: ["y"] })
    );
    expect(got.map((f) => f.col)).toEqual([0, 2]);
  });
});

describe("isFiltered", () => {
  it("中身のある絞り込みだけを数える", () => {
    expect(isFiltered([filter({ col: 1, values: [] })], 1)).toBe(true);
    expect(isFiltered([filter({ col: 1 })], 1)).toBe(false);
    expect(isFiltered([], 1)).toBe(false);
  });
});

describe("matching", () => {
  it("大小を区別せずに絞る", () => {
    expect(matching(values, "app").map((v) => v.text)).toEqual(["Apple"]);
  });

  it("空なら全部そのまま", () => {
    expect(matching(values, "  ")).toHaveLength(3);
  });
});

describe("pickedValues", () => {
  it("全部選んでいれば絞らない", () => {
    const all = new Set(values.map((v) => v.text));
    expect(pickedValues(values, all)).toBeNull();
  });

  it("選んだものだけを並べる", () => {
    expect(pickedValues(values, new Set(["Apple", ""]))).toEqual(["Apple", ""]);
  });

  it("1つも選んでいなければ空の一覧", () => {
    expect(pickedValues(values, new Set())).toEqual([]);
  });
});

describe("usableRules", () => {
  it("値の要る条件で空欄のものは渡さない", () => {
    const got = usableRules([
      { kind: "contains", value: "" },
      { kind: "contains", value: "a" },
      { kind: "empty", value: "" },
    ]);
    expect(got).toEqual([
      { kind: "contains", value: "a" },
      { kind: "empty", value: "" },
    ]);
  });
});

describe("filterLabel", () => {
  it("絞っていなければ誘い文句を出す", () => {
    expect(filterLabel(undefined)).toBe("この列で絞り込む");
    expect(filterLabel(filter())).toBe("この列で絞り込む");
  });

  it("値と条件を並べる", () => {
    const f = filter({
      values: ["a", "b"],
      rules: [{ kind: "contains", value: "x" }],
    });
    expect(filterLabel(f)).toBe("2個の値 かつ 「x」を含む で絞り込み中");
  });

  it("または で見ているときはその言い方にする", () => {
    const f = filter({
      all: false,
      rules: [
        { kind: "empty", value: "" },
        { kind: "contains", value: "x" },
      ],
    });
    expect(filterLabel(f)).toBe("が空 または 「x」を含む で絞り込み中");
  });
});
