import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  setSpansEffect,
  spansField,
  targetAt,
  targetLines,
} from "./sqlTarget";
import { spansOf } from "../sqlSpans";

/** `;` で区切ったSQLから、そのまま文の範囲を作る (バックエンドの代わり) */
function stateOf(doc: string, cursor: number, head?: number): EditorState {
  const stmts = doc
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const state = EditorState.create({
    doc,
    extensions: [spansField],
    selection: EditorSelection.single(cursor, head ?? cursor),
  });
  return state.update({ effects: setSpansEffect.of(spansOf(doc, stmts)) })
    .state;
}

const SQL = "select 1;\nselect 2;\nselect 3;";

describe("targetAt", () => {
  it("カーソルのある文を指す", () => {
    expect(targetAt(stateOf(SQL, 3))).toEqual({ index: 0, total: 3 });
    expect(targetAt(stateOf(SQL, 13))).toEqual({ index: 1, total: 3 });
    expect(targetAt(stateOf(SQL, 23))).toEqual({ index: 2, total: 3 });
  });

  it("選択しているときは対象なし (選択が走るため)", () => {
    expect(targetAt(stateOf(SQL, 0, 8))).toEqual({ index: -1, total: 3 });
  });

  it("1文だけなら示さない (実行がそのまま全体になる)", () => {
    expect(targetAt(stateOf("select 1", 3))).toEqual({ index: -1, total: 1 });
  });

  it("空なら何も無い", () => {
    expect(targetAt(stateOf("", 0))).toEqual({ index: -1, total: 0 });
  });
});

describe("targetLines", () => {
  it("複数行にまたがる文は全部の行を返す", () => {
    const sql = "select 1;\nselect a\n  from t\n  where x = 1;\nselect 3;";
    // 2文目 (2〜4行目) の中にカーソルを置く
    expect(targetLines(stateOf(sql, sql.indexOf("from")))).toEqual({
      first: 2,
      last: 4,
    });
  });

  it("対象が無ければ null", () => {
    expect(targetLines(stateOf("select 1", 0))).toBeNull();
  });
});

describe("spansField", () => {
  it("打った分だけ範囲がずれる (分け直しが届くまでのつなぎ)", () => {
    const before = stateOf(SQL, 0);
    // 先頭に2文字入れると、後ろの文も2文字ぶん後ろへ動く
    const after = before.update({
      changes: { from: 0, insert: "--" },
      selection: EditorSelection.cursor(15),
    }).state;
    expect(targetAt(after)).toEqual({ index: 1, total: 3 });
  });
});
