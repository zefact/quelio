import { describe, expect, it } from "vitest";
import { buildTree, isInside, resolveDrop } from "./savedTree";
import type { SavedSqlEntry, SavedSqlStore } from "./types";

function item(id: string, folder: string): SavedSqlEntry {
  return { id, name: id, folder, sql: "SELECT 1", updatedAtMs: 0 };
}

/** 集計 / 集計・月次 / 他 の3フォルダと、項目4件 */
function store(): SavedSqlStore {
  return {
    folders: ["集計", "集計/月次", "他"],
    items: [
      item("a", ""),
      item("b", "集計"),
      item("c", "集計"),
      item("d", "集計/月次"),
    ],
  };
}

describe("お気に入りのツリー", () => {
  it("保存されている並びのままフォルダと項目を組み立てる", () => {
    const t = buildTree(store());
    expect(t.folders.map((f) => f.path)).toEqual(["集計", "他"]);
    expect(t.items.map((e) => e.id)).toEqual(["a"]);
    const shukei = t.folders[0];
    expect(shukei.folders.map((f) => f.name)).toEqual(["月次"]);
    expect(shukei.items.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("空のフォルダも残る (項目から起こしていないため)", () => {
    const t = buildTree({ folders: ["空"], items: [] });
    expect(t.folders.map((f) => f.path)).toEqual(["空"]);
  });
});

describe("ドラッグの落とし先", () => {
  it("項目をフォルダの中へ落とすと末尾に入る", () => {
    const r = resolveDrop(store(), { type: "item", id: "a" }, {
      type: "into",
      path: "集計",
    });
    expect(r).toEqual({ kind: "item", id: "a", folder: "集計", index: 2 });
  });

  it("項目を別の項目の前後へ落とす", () => {
    const s = store();
    expect(
      resolveDrop(s, { type: "item", id: "a" }, {
        type: "before",
        kind: "item",
        id: "c",
      })
    ).toEqual({ kind: "item", id: "a", folder: "集計", index: 1 });
    expect(
      resolveDrop(s, { type: "item", id: "a" }, {
        type: "after",
        kind: "item",
        id: "c",
      })
    ).toEqual({ kind: "item", id: "a", folder: "集計", index: 2 });
  });

  it("同じフォルダの中で動かすときは、自分を除いた並びで数える", () => {
    // b を c の後ろへ: 自分を除くと [c] なので index=1
    const r = resolveDrop(store(), { type: "item", id: "b" }, {
      type: "after",
      kind: "item",
      id: "c",
    });
    expect(r).toEqual({ kind: "item", id: "b", folder: "集計", index: 1 });
  });

  it("自分自身の上に落としても何も起きない", () => {
    expect(
      resolveDrop(store(), { type: "item", id: "b" }, {
        type: "before",
        kind: "item",
        id: "b",
      })
    ).toBeNull();
  });

  it("一番下の余白へ落とすとルートの末尾へ", () => {
    expect(
      resolveDrop(store(), { type: "item", id: "b" }, { type: "root-end" })
    ).toEqual({ kind: "item", id: "b", folder: "", index: 1 });
  });

  it("フォルダを別のフォルダの中へ入れられる", () => {
    expect(
      resolveDrop(store(), { type: "folder", path: "他" }, {
        type: "into",
        path: "集計",
      })
    ).toEqual({ kind: "folder", path: "他", parent: "集計", index: 1 });
  });

  it("フォルダを自分の下へは入れられない", () => {
    expect(
      resolveDrop(store(), { type: "folder", path: "集計" }, {
        type: "into",
        path: "集計/月次",
      })
    ).toBeNull();
    expect(
      resolveDrop(store(), { type: "folder", path: "集計" }, {
        type: "before",
        kind: "folder",
        path: "集計/月次",
      })
    ).toBeNull();
    // 自分の中の項目の前後も同じ
    expect(
      resolveDrop(store(), { type: "folder", path: "集計" }, {
        type: "after",
        kind: "item",
        id: "d",
      })
    ).toBeNull();
  });

  it("フォルダ同士の並べ替えも、自分を除いた並びで数える", () => {
    // 「他」を「集計」の前へ: 自分を除くと [集計] なので index=0
    expect(
      resolveDrop(store(), { type: "folder", path: "他" }, {
        type: "before",
        kind: "folder",
        path: "集計",
      })
    ).toEqual({ kind: "folder", path: "他", parent: "", index: 0 });
  });

  it("置けない場所は null", () => {
    expect(
      resolveDrop(store(), { type: "item", id: "a" }, {
        type: "denied",
        key: "集計",
      })
    ).toBeNull();
  });
});

describe("パスの判定", () => {
  it("自分自身と、その下を「中」とみなす", () => {
    expect(isInside("集計/月次", "集計")).toBe(true);
    expect(isInside("集計", "集計")).toBe(true);
    expect(isInside("集計外", "集計")).toBe(false);
    // ルート ("") は全部を含む
    expect(isInside("何か", "")).toBe(true);
  });
});
