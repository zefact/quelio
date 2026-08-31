import { describe, expect, it } from "vitest";
import { diffResults, rowKey } from "./resultDiff";

const cols = ["id", "name"];

describe("結果の差分", () => {
  it("同じ内容なら差分は出ない", () => {
    const rows = [
      ["1", "山田"],
      ["2", "佐藤"],
    ];
    const d = diffResults(cols, rows, cols, rows);
    expect(d.sameColumns).toBe(true);
    expect([...d.onlyLeft]).toEqual([]);
    expect([...d.onlyRight]).toEqual([]);
  });

  it("並び順が違っても同じ内容なら差分にしない", () => {
    const a = [
      ["1", "山田"],
      ["2", "佐藤"],
    ];
    const b = [
      ["2", "佐藤"],
      ["1", "山田"],
    ];
    const d = diffResults(cols, a, cols, b);
    expect([...d.onlyLeft]).toEqual([]);
    expect([...d.onlyRight]).toEqual([]);
  });

  it("増えた行・消えた行の位置を返す", () => {
    const a = [
      ["1", "山田"],
      ["2", "佐藤"],
    ];
    const b = [
      ["1", "山田"],
      ["3", "鈴木"],
    ];
    const d = diffResults(cols, a, cols, b);
    // 左 (ピン留め) にしか無い = 消えた行
    expect([...d.onlyLeft]).toEqual([1]);
    // 右 (今回) にしか無い = 増えた行
    expect([...d.onlyRight]).toEqual([1]);
  });

  it("同じ内容の行は数が合っているぶんだけ打ち消す", () => {
    const a = [
      ["1", "山田"],
      ["1", "山田"],
      ["1", "山田"],
    ];
    const b = [
      ["1", "山田"],
      ["1", "山田"],
    ];
    const d = diffResults(cols, a, cols, b);
    expect(d.onlyLeft.size).toBe(1);
    expect(d.onlyRight.size).toBe(0);
  });

  it("NULLと空文字を混同しない", () => {
    const d = diffResults(cols, [["1", null]], cols, [["1", ""]]);
    expect(d.onlyLeft.size).toBe(1);
    expect(d.onlyRight.size).toBe(1);
    expect(rowKey([null])).not.toBe(rowKey([""]));
  });

  it("値の区切り方が違うだけの行を同じ行にしない", () => {
    const d = diffResults(cols, [["a", "b"]], cols, [["ab", ""]]);
    expect(d.onlyLeft.size).toBe(1);
    expect(d.onlyRight.size).toBe(1);
  });

  it("列が違うときは行の差分を出さない", () => {
    const d = diffResults(cols, [["1", "山田"]], ["id"], [["1"]]);
    expect(d.sameColumns).toBe(false);
    expect(d.onlyLeft.size).toBe(0);
    expect(d.onlyRight.size).toBe(0);
  });
});
