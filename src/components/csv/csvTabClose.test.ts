import { describe, expect, it } from "vitest";
import type { CsvInfo } from "../../types";
import { closeTargets, unsaved } from "./csvTabClose";

/** 試すのに要る所だけを持ったタブ */
function tab(docId: string, dirty = false): CsvInfo {
  return {
    docId,
    name: docId,
    path: null,
    format: {
      encoding: "UTF-8",
      newline: "lf",
      delimiter: ",",
      quoting: "necessary",
      bom: false,
      fixed: null,
    },
    hasHeader: true,
    columns: ["a"],
    rowCount: 0,
    dirty,
    ragged: false,
    replaced: false,
    undoLabel: null,
    redoLabel: null,
  };
}

const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];

describe("closeTargets", () => {
  it("自分だけを閉じる", () => {
    expect(closeTargets(tabs, tabs[1], "self").map((t) => t.docId)).toEqual(["b"]);
  });

  it("その他は自分以外を並び順のまま返す", () => {
    expect(closeTargets(tabs, tabs[1], "others").map((t) => t.docId)).toEqual([
      "a",
      "c",
      "d",
    ]);
  });

  it("右側は自分より後ろだけを返す", () => {
    expect(closeTargets(tabs, tabs[1], "right").map((t) => t.docId)).toEqual([
      "c",
      "d",
    ]);
  });

  it("一番右なら右側は空", () => {
    expect(closeTargets(tabs, tabs[3], "right")).toEqual([]);
  });

  it("すべては全部を返す", () => {
    expect(closeTargets(tabs, tabs[0], "all")).toHaveLength(4);
  });

  it("並びに無いタブなら何も返さない", () => {
    expect(closeTargets(tabs, tab("z"), "others")).toEqual([]);
  });
});

describe("unsaved", () => {
  it("保存していないものだけを拾う", () => {
    const list = [tab("a"), tab("b", true), tab("c", true)];
    expect(unsaved(list).map((t) => t.docId)).toEqual(["b", "c"]);
  });
});
