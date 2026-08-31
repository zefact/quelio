import { describe, expect, it } from "vitest";
import {
  buildTree,
  childRefs,
  isInside,
  resolveDrop,
  type SavedChild,
} from "./savedTree";
import type { SavedSqlEntry, SavedSqlStore } from "./types";

function item(id: string, folder: string): SavedSqlEntry {
  return { id, name: id, folder, sql: "SELECT 1", updatedAtMs: 0 };
}

/**
 * 集計 / 集計・月次 / 他 の3フォルダと、項目4件。
 * 表示順はルートが「集計 → a → 他」で、フォルダと項目が混ざった並び
 */
function store(): SavedSqlStore {
  return {
    folders: ["集計", "集計/月次", "他"],
    items: [
      item("a", ""),
      item("b", "集計"),
      item("c", "集計"),
      item("d", "集計/月次"),
    ],
    order: [
      "f:集計",
      "i:b",
      "f:集計/月次",
      "i:c",
      "i:d",
      "i:a",
      "f:他",
    ],
  };
}

/** ツリーの子を "種類:名前" で並べる (見え方の確認用) */
function labels(children: SavedChild[]): string[] {
  return children.map((c) =>
    c.kind === "folder" ? `f:${c.node.name}` : `i:${c.entry.id}`
  );
}

describe("お気に入りのツリー", () => {
  it("フォルダと項目を混ぜた並びのまま組み立てる", () => {
    const t = buildTree(store());
    // 集計 → a → 他 の順 (フォルダの間に項目が入る)
    expect(labels(t.children)).toEqual(["f:集計", "i:a", "f:他"]);
    const shukei = t.children[0];
    expect(shukei.kind).toBe("folder");
    if (shukei.kind !== "folder") return;
    // 集計の中も、保存されている順のまま (項目→フォルダ→項目)
    expect(labels(shukei.node.children)).toEqual(["i:b", "f:月次", "i:c"]);
  });

  it("空のフォルダも残る (項目から起こしていないため)", () => {
    const t = buildTree({ folders: ["空"], items: [], order: ["f:空"] });
    expect(labels(t.children)).toEqual(["f:空"]);
  });

  it("並びに載っていないものは出さない", () => {
    // order が唯一の表示順 (保存側が読み込み時に必ず整える)
    const t = buildTree({ folders: ["箱"], items: [item("x", "")], order: [] });
    expect(t.children).toEqual([]);
  });

  it("その階層の並びだけを取り出せる", () => {
    expect(childRefs(store(), "")).toEqual(["f:集計", "i:a", "f:他"]);
    expect(childRefs(store(), "集計")).toEqual(["i:b", "f:集計/月次", "i:c"]);
  });
});

describe("ドラッグの落とし先", () => {
  it("フォルダの中へ落とすと末尾に入る", () => {
    expect(
      resolveDrop(store(), { type: "item", id: "a" }, { type: "into", path: "集計" })
    ).toEqual({ node: "i:a", parent: "集計", before: null });
  });

  it("項目を別の項目の前後へ落とす", () => {
    const s = store();
    expect(
      resolveDrop(s, { type: "item", id: "a" }, {
        type: "before",
        kind: "item",
        id: "c",
      })
    ).toEqual({ node: "i:a", parent: "集計", before: "i:c" });
    // 後ろ = 次の兄弟の直前 (次が無ければ末尾)
    expect(
      resolveDrop(s, { type: "item", id: "a" }, {
        type: "after",
        kind: "item",
        id: "c",
      })
    ).toEqual({ node: "i:a", parent: "集計", before: null });
  });

  it("フォルダを項目の前後へ置ける (混ぜた並びにできる)", () => {
    // 「他」を項目 b の後ろ (= 月次の直前) へ
    expect(
      resolveDrop(store(), { type: "folder", path: "他" }, {
        type: "after",
        kind: "item",
        id: "b",
      })
    ).toEqual({ node: "f:他", parent: "集計", before: "f:集計/月次" });
  });

  it("項目をフォルダの前後へ置ける", () => {
    expect(
      resolveDrop(store(), { type: "item", id: "a" }, {
        type: "before",
        kind: "folder",
        path: "集計/月次",
      })
    ).toEqual({ node: "i:a", parent: "集計", before: "f:集計/月次" });
  });

  it("同じ階層で動かすときは、自分を除いた並びで次を決める", () => {
    // b を c の後ろへ: 自分を除くと [月次, c] なので、c の次は無く末尾
    expect(
      resolveDrop(store(), { type: "item", id: "b" }, {
        type: "after",
        kind: "item",
        id: "c",
      })
    ).toEqual({ node: "i:b", parent: "集計", before: null });
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

  it("1行目の前へ落とすと、いちばん上へ移動する", () => {
    // 一覧の1行目 (フォルダ「集計」) の前 = ルートの先頭
    expect(
      resolveDrop(store(), { type: "item", id: "b" }, {
        type: "before",
        kind: "folder",
        path: "集計",
      })
    ).toEqual({ node: "i:b", parent: "", before: "f:集計" });
  });

  it("一番下の余白へ落とすとルートの末尾へ", () => {
    expect(
      resolveDrop(store(), { type: "item", id: "b" }, { type: "root-end" })
    ).toEqual({ node: "i:b", parent: "", before: null });
  });

  it("フォルダを別のフォルダの中へ入れられる", () => {
    expect(
      resolveDrop(store(), { type: "folder", path: "他" }, {
        type: "into",
        path: "集計",
      })
    ).toEqual({ node: "f:他", parent: "集計", before: null });
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
