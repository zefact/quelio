import { describe, expect, it } from "vitest";
import type { CsvFixedLayout, CsvLayoutNode } from "../../types";
import {
  addFolder,
  applyMove,
  endSpot,
  flatLayouts,
  folderNames,
  hitRow,
  removeFolder,
  renameFolder,
  rowsOf,
  spotAt,
  usedName,
} from "./csvLayoutTree";

const layout: CsvFixedLayout = {
  unit: "byte",
  columns: [{ width: 3, align: "left", pad: " ", name: "列1" }],
  trim: true,
  newline: true,
  header: [],
  trailer: [],
  kinds: [],
};

function saved(name: string) {
  return { name, layout, updatedAtMs: 0 };
}

function item(name: string): CsvLayoutNode {
  return { kind: "item", ...saved(name) };
}

function folder(name: string, items: string[]): CsvLayoutNode {
  return { kind: "folder", name, items: items.map(saved) };
}

/** あ / [受注: い, う] / え */
function tree(): CsvLayoutNode[] {
  return [item("あ"), folder("受注", ["い", "う"]), item("え")];
}

describe("並び", () => {
  it("並んでいる順に平らにする", () => {
    expect(flatLayouts(tree()).map((s) => s.name)).toEqual([
      "あ",
      "い",
      "う",
      "え",
    ]);
  });

  it("フォルダの次にその中身が並ぶ", () => {
    const rows = rowsOf(tree());
    expect(rows.map((r) => (r.type === "folder" ? r.name : r.saved.name))).toEqual(
      ["あ", "受注", "い", "う", "え"]
    );
    expect(rows[2]).toMatchObject({ folder: "受注", at: 0 });
  });

  it("フォルダの名前を並び順に取れる", () => {
    expect(folderNames(tree())).toEqual(["受注"]);
  });
});

describe("放す場所", () => {
  const rows = rowsOf(tree());

  it("お気に入りをフォルダの行へ放すと中の末尾に入る", () => {
    const spot = spotAt(rows[1], true, { type: "item", name: "あ" });
    expect(spot).toEqual({ folder: "受注", index: 2 });
  });

  it("行の上半分なら手前、下半分なら後ろ", () => {
    const drag = { type: "item", name: "え" } as const;
    expect(spotAt(rows[2], true, drag)).toEqual({ folder: "受注", index: 0 });
    expect(spotAt(rows[2], false, drag)).toEqual({ folder: "受注", index: 1 });
  });

  it("フォルダはフォルダの中へは入れられない", () => {
    expect(spotAt(rows[2], true, { type: "folder", name: "受注" })).toBeNull();
  });

  it("一番下は上の並びの末尾", () => {
    expect(endSpot(tree())).toEqual({ folder: null, index: 3 });
  });
});

describe("どの行の上か", () => {
  const boxes = [
    { top: 100, height: 20 },
    { top: 120, height: 20 },
  ];

  it("上半分と下半分を見分ける", () => {
    expect(hitRow(boxes, 105)).toEqual({ index: 0, upper: true });
    expect(hitRow(boxes, 115)).toEqual({ index: 0, upper: false });
    expect(hitRow(boxes, 125)).toEqual({ index: 1, upper: true });
    expect(hitRow(boxes, 135)).toEqual({ index: 1, upper: false });
  });

  it("どの行にも掛かっていなければ何も返さない", () => {
    expect(hitRow(boxes, 90)).toBeNull();
    expect(hitRow(boxes, 200)).toBeNull();
  });
});

describe("動かす", () => {
  it("上の並びからフォルダの中へ入れられる", () => {
    const out = applyMove(tree(), { type: "item", name: "あ" }, {
      folder: "受注",
      index: 2,
    });
    expect(flatLayouts(out).map((s) => s.name)).toEqual(["い", "う", "あ", "え"]);
    expect(rowsOf(out)[0]).toMatchObject({ type: "folder" });
  });

  it("フォルダの中から外へ出せる", () => {
    const out = applyMove(tree(), { type: "item", name: "い" }, {
      folder: null,
      index: 0,
    });
    expect(flatLayouts(out).map((s) => s.name)).toEqual(["い", "あ", "う", "え"]);
  });

  it("同じ並びの中で下へ動かすと、抜いたぶんずれない", () => {
    const out = applyMove(tree(), { type: "item", name: "い" }, {
      folder: "受注",
      index: 2,
    });
    expect(flatLayouts(out).map((s) => s.name)).toEqual(["あ", "う", "い", "え"]);
  });

  it("フォルダごと並べ替えられる", () => {
    const out = applyMove(tree(), { type: "folder", name: "受注" }, {
      folder: null,
      index: 0,
    });
    expect(rowsOf(out).map((r) => (r.type === "folder" ? r.name : r.saved.name))).toEqual(
      ["受注", "い", "う", "あ", "え"]
    );
  });

  it("知らない名前なら何も変えない", () => {
    const before = tree();
    expect(applyMove(before, { type: "item", name: "ない" }, endSpot(before))).toBe(
      before
    );
  });
});

describe("フォルダ", () => {
  it("作ると一番下に付く", () => {
    const out = addFolder(tree(), "出荷");
    expect(folderNames(out)).toEqual(["受注", "出荷"]);
  });

  it("名前を変えても中身はそのまま", () => {
    const out = renameFolder(tree(), "受注", "受注データ");
    expect(folderNames(out)).toEqual(["受注データ"]);
    expect(flatLayouts(out)).toHaveLength(4);
  });

  it("外すと中身はその場所に出る", () => {
    const out = removeFolder(tree(), "受注");
    expect(folderNames(out)).toEqual([]);
    expect(rowsOf(out).map((r) => (r.type === "folder" ? r.name : r.saved.name))).toEqual(
      ["あ", "い", "う", "え"]
    );
  });

  it("フォルダ名とお気に入り名は別々に見る", () => {
    expect(usedName(tree(), "受注", "folder")).toBe(true);
    expect(usedName(tree(), "受注", "item")).toBe(false);
    expect(usedName(tree(), "い", "item")).toBe(true);
  });
});
