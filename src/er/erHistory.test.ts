import { describe, expect, it } from "vitest";
import {
  emptyHistory,
  recordHistory,
  redoHistory,
  sameErDoc,
  toErDoc,
  undoHistory,
  type ErDoc,
} from "./erHistory";

describe("元に戻す / やり直すの履歴", () => {
  it("積んだ順の逆に戻す", () => {
    let h = emptyHistory<number>();
    h = recordHistory(h, 1);
    h = recordHistory(h, 2);
    const u1 = undoHistory(h, 3)!;
    expect(u1.state).toBe(2);
    const u2 = undoHistory(u1.history, u1.state)!;
    expect(u2.state).toBe(1);
    expect(undoHistory(u2.history, u2.state)).toBeNull();
  });

  it("戻したものをやり直せる", () => {
    let h = recordHistory(emptyHistory<number>(), 1);
    const u = undoHistory(h, 2)!;
    expect(u.state).toBe(1);
    const r = redoHistory(u.history, u.state)!;
    expect(r.state).toBe(2);
    expect(redoHistory(r.history, r.state)).toBeNull();
    // やり直したあとは、また戻せる
    h = r.history;
    expect(undoHistory(h, r.state)!.state).toBe(1);
  });

  it("新しく変えたら、やり直しの分は捨てる", () => {
    const h = recordHistory(emptyHistory<number>(), 1);
    const u = undoHistory(h, 2)!;
    const h2 = recordHistory(u.history, u.state);
    expect(h2.future).toEqual([]);
    expect(redoHistory(h2, 5)).toBeNull();
  });

  it("上限を超えたら古いものから捨てる", () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < 5; i++) h = recordHistory(h, i, 3);
    expect(h.past).toEqual([2, 3, 4]);
  });

  it("元の履歴は書き換えない", () => {
    const h = recordHistory(emptyHistory<number>(), 1);
    undoHistory(h, 2);
    expect(h.past).toEqual([1]);
    expect(h.future).toEqual([]);
  });
});

describe("ER図の中身の比較", () => {
  const base = (): Parameters<typeof toErDoc>[0] => ({
    entries: [],
    fks: [],
    positions: new Map([["users", { x: 1, y: 2 }]]),
    options: { allCols: true, showLogical: true, showTypes: true },
    removedEdges: new Set(),
    removedTables: new Set(),
    manualTables: new Set(),
    tableWidths: {},
    customEdges: [],
    anchors: {},
    edgeColumns: {},
    edgeStyles: {},
    columnColors: {},
    frames: [],
  });

  it("位置は写しを取る (あとで Map を書き換えても積んだものは変わらない)", () => {
    const s = base();
    const doc = toErDoc(s);
    s.positions.get("users")!.x = 99;
    s.positions.set("orders", { x: 0, y: 0 });
    expect(doc.positions).toEqual({ users: { x: 1, y: 2 } });
  });

  it("表示を動かしただけ (中身が同じ) なら同じとみなす", () => {
    const s = base();
    const a = toErDoc(s);
    // 空の一覧が作り直されても同じ
    const b = toErDoc({ ...s, entries: [], fks: [] });
    expect(sameErDoc(a, b)).toBe(true);
  });

  it("テーブルを動かしたら違うとみなす", () => {
    const s = base();
    const a = toErDoc(s);
    s.positions.set("users", { x: 5, y: 2 });
    expect(sameErDoc(a, toErDoc(s))).toBe(false);
  });

  it("表示設定や枠を変えたら違うとみなす", () => {
    const s = base();
    const a: ErDoc = toErDoc(s);
    expect(
      sameErDoc(a, toErDoc({ ...s, options: { ...s.options, allCols: false } }))
    ).toBe(false);
    expect(sameErDoc(a, toErDoc({ ...s, frames: [] }))).toBe(false);
  });
});
