import { describe, expect, it } from "vitest";
import { EDITOR_MEMO_LIMIT, loadEditorView, saveEditorView } from "./sqlEditorMemo";

describe("SQLエディタの見た目の控え", () => {
  it("本文の長さが同じときだけ戻す", () => {
    const state = { snapshot: {}, anchor: 10, head: 14, docLength: 120 };
    saveEditorView("tab1:s1", state);
    expect(loadEditorView("tab1:s1", 120)).toBe(state);
    expect(loadEditorView("tab1:s1", 121)).toBeUndefined();
    expect(loadEditorView("tab1:s2", 120)).toBeUndefined();
  });

  it("上限を超えたら古いものから捨てる", () => {
    for (let i = 0; i <= EDITOR_MEMO_LIMIT; i++) {
      saveEditorView(`k${i}`, { snapshot: {}, anchor: 0, head: 0, docLength: 1 });
    }
    expect(loadEditorView("k0", 1)).toBeUndefined();
    expect(loadEditorView(`k${EDITOR_MEMO_LIMIT}`, 1)).toBeDefined();
  });
});
