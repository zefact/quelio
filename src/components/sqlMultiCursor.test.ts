import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  atColumn,
  columnAt,
  edgeColumn,
  headColumn,
  nextColumn,
} from "./sqlMultiCursor";

/** 長さの違う3行 (行頭は 0 / 5 / 8) */
const DOC = "abcd\nab\nabcd";

/** カーソルを縦に並べた状態 */
function cursors(doc: string, at: number[]) {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(at.map((p) => EditorSelection.cursor(p))),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
}

/** 範囲を選んだ状態 */
function ranges(doc: string, at: [number, number][]) {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(
      at.map(([a, h]) => EditorSelection.range(a, h))
    ),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
}

/** 覚えている桁から1つ動かして、置き直したあとのカーソル位置 */
function press(
  state: EditorState,
  stored: number | null,
  forward: boolean,
  select = false
) {
  const col = nextColumn(state, stored, forward, select);
  return { col, at: atColumn(state, col, select).ranges.map((r) => r.head) };
}

describe("columnAt", () => {
  it("行頭からの桁を返す", () => {
    const s = cursors(DOC, [0]);
    expect(columnAt(s, 0)).toBe(0);
    expect(columnAt(s, 2)).toBe(2);
    // 2行目の先頭 (位置5) は0桁目
    expect(columnAt(s, 5)).toBe(0);
    expect(columnAt(s, 7)).toBe(2);
  });

  it("タブは次の区切りまで数える", () => {
    const s = EditorState.create({ doc: "\tab", extensions: [] });
    expect(columnAt(s, 1)).toBe(4);
    expect(columnAt(s, 2)).toBe(5);
  });
});

describe("headColumn / edgeColumn", () => {
  it("短い行で止まっているカーソルに引きずられない", () => {
    // 3桁目に並べたが、真ん中の行は2文字しかないので行末 (2桁目) にいる
    expect(headColumn(cursors(DOC, [3, 7, 11]))).toBe(3);
  });

  it("範囲を選んでいるときは端の桁", () => {
    const s = ranges(DOC, [
      [1, 3],
      [6, 7],
    ]);
    expect(edgeColumn(s, true)).toBe(3);
    expect(edgeColumn(s, false)).toBe(1);
  });
});

describe("nextColumn / atColumn — 縦のラインを保つ", () => {
  it("右へ動かすと、短い行は行末で待つ", () => {
    const s = cursors(DOC, [2, 7, 10]);
    expect(press(s, null, true)).toEqual({ col: 3, at: [3, 7, 11] });
  });

  it("行末で待っていたカーソルも、桁が戻れば並びに戻る", () => {
    // 3桁目まで進んだ状態: 真ん中だけ行末 (2桁目) に留まっている
    const s = cursors(DOC, [3, 7, 11]);
    // さらに右 → 4桁目
    expect(press(s, 3, true)).toEqual({ col: 4, at: [4, 7, 12] });
    // 左へ戻す → 2桁目で3つとも揃う
    expect(press(cursors(DOC, [4, 7, 12]), 4, false)).toEqual({
      col: 3,
      at: [3, 7, 11],
    });
    expect(press(cursors(DOC, [3, 7, 11]), 3, false)).toEqual({
      col: 2,
      at: [2, 7, 10],
    });
  });

  it("覚えていないときは、いちばん右のカーソルの桁から動かす", () => {
    // 覚えている桁が無くても、短い行に引きずられない
    expect(press(cursors(DOC, [3, 7, 11]), null, true).col).toBe(4);
  });

  it("行頭より左へは行かない", () => {
    expect(press(cursors(DOC, [0, 5, 8]), 0, false)).toEqual({
      col: 0,
      at: [0, 5, 8],
    });
  });

  it("いちばん長い行の先へは行かない", () => {
    // 4桁でいちばん長い行の行末。押し続けても桁は増えない
    expect(press(cursors(DOC, [4, 7, 12]), 4, true).col).toBe(4);
  });

  it("Shiftで広げるときは、錨を残したまま桁を動かす", () => {
    const s = cursors(DOC, [2, 7, 10]);
    const col = nextColumn(s, null, true, true);
    expect(atColumn(s, col, true).ranges.map((r) => [r.anchor, r.head])).toEqual(
      [
        [2, 3],
        [7, 7],
        [10, 11],
      ]
    );
  });

  it("範囲を選んでいて広げないなら、その端へ畳む", () => {
    const s = ranges(DOC, [
      [1, 3],
      [6, 7],
    ]);
    expect(press(s, null, true)).toEqual({ col: 3, at: [3, 7] });
    expect(press(s, null, false)).toEqual({ col: 1, at: [1, 6] });
  });

  it("主カーソルの番号は変わらない", () => {
    const s = cursors(DOC, [2, 7, 10]);
    expect(atColumn(s, 3, false).mainIndex).toBe(s.selection.mainIndex);
  });
});
