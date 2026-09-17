import { describe, expect, it } from "vitest";

import { isStrayFileDrop } from "./blockShortcuts";

describe("isStrayFileDrop", () => {
  it("受け取る場所の外のファイルは引き取る", () => {
    expect(isStrayFileDrop(false, ["Files"], false)).toBe(true);
    // ファイル名と一緒に来ることもある
    expect(isStrayFileDrop(false, ["text/uri-list", "Files"], false)).toBe(true);
  });

  it("受け取る場所の中なら何もしない", () => {
    // CSV取り込み・データ転送の置き場所 ([data-file-drop] の内側)
    expect(isStrayFileDrop(false, ["Files"], true)).toBe(false);
  });

  it("すでに誰かが受け取っていれば何もしない", () => {
    expect(isStrayFileDrop(true, ["Files"], false)).toBe(false);
  });

  it("文字の落とし込みは邪魔しない", () => {
    // SQLエディタ・入力欄への貼り付けや、並べ替えのドラッグ
    expect(isStrayFileDrop(false, ["text/plain"], false)).toBe(false);
    expect(isStrayFileDrop(false, ["text/plain", "text/html"], false)).toBe(false);
    expect(isStrayFileDrop(false, [], false)).toBe(false);
  });

  it("種類が分からなければ何もしない", () => {
    expect(isStrayFileDrop(false, undefined, false)).toBe(false);
  });
});
