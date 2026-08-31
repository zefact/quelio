import { describe, expect, it } from "vitest";
import { cellKind, columnKinds, kindAlign, kindClass } from "./cellKind";

describe("cellKind", () => {
  it("数値", () => {
    for (const v of ["0", "12", "-3", "1.5", "-0.25"]) {
      expect(cellKind(v), v).toBe("number");
    }
  });

  it("先頭に0が続くものは数値にしない (郵便番号・コード)", () => {
    for (const v of ["007", "0120", "00"]) {
      expect(cellKind(v), v).toBe("text");
    }
  });

  it("日付・日時", () => {
    for (const v of [
      "2026-08-31",
      "2026-08-31 12:34:56",
      "2026-08-31T12:34:56",
      "2026-08-31T12:34:56.789Z",
      "2026-08-31T12:34:56+09:00",
    ]) {
      expect(cellKind(v), v).toBe("date");
    }
  });

  it("真偽 (PostgreSQLのt/fも)", () => {
    for (const v of ["true", "FALSE", "t", "f"]) {
      expect(cellKind(v), v).toBe("bool");
    }
  });

  it("それ以外は text", () => {
    for (const v of ["", "abc", "1,000", "2026/08/31", "1e5"]) {
      expect(cellKind(v), v).toBe("text");
    }
  });
});

describe("columnKinds", () => {
  it("列ごとに、値がそろっているときだけ種類を付ける", () => {
    const rows = [
      ["1", "2026-08-31", "t", "abc"],
      ["2", "2026-09-01", "f", "1"],
    ];
    expect(columnKinds(rows, 4)).toEqual(["number", "date", "bool", "text"]);
  });

  it("1つでも種類が違えば text にする", () => {
    expect(columnKinds([["1"], ["x"]], 1)).toEqual(["text"]);
  });

  it("NULLは数えない", () => {
    expect(columnKinds([[null], ["1"], [null]], 1)).toEqual(["number"]);
  });

  it("全部NULL・0行の列は text", () => {
    expect(columnKinds([[null], [null]], 1)).toEqual(["text"]);
    expect(columnKinds([], 2)).toEqual(["text", "text"]);
  });

  it("行ごとに列が欠けていても落ちない", () => {
    expect(columnKinds([["1"], []], 2)).toEqual(["number", "text"]);
  });
});

describe("表示の割り当て", () => {
  it("数値だけ右寄せ", () => {
    expect(kindAlign("number")).toBe("right");
    expect(kindAlign("date")).toBeUndefined();
    expect(kindAlign("text")).toBeUndefined();
  });

  it("日付と真偽だけ色を変える", () => {
    expect(kindClass("date")).toBe("cell-date");
    expect(kindClass("bool")).toBe("cell-bool");
    expect(kindClass("number")).toBeUndefined();
    expect(kindClass("text")).toBeUndefined();
  });
});
