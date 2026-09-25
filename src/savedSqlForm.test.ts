import { describe, expect, it } from "vitest";
import {
  canImport,
  folderExists,
  folderLabel,
  folderNameError,
  folderOptions,
  foldersToOpen,
  fmtUpdated,
  newFolderPath,
} from "./savedSqlForm";

describe("newFolderPath", () => {
  it("選んでいるフォルダの中に作る", () => {
    expect(newFolderPath("集計", "月次")).toBe("集計/月次");
    expect(newFolderPath("", "月次")).toBe("月次");
  });

  it("名前が空なら、選んでいるフォルダのまま", () => {
    expect(newFolderPath("集計", "  ")).toBe("集計");
  });

  it("前後の空白は落とす", () => {
    expect(newFolderPath("", " 月次 ")).toBe("月次");
  });
});

describe("folderNameError", () => {
  it("「/」は使えない (階層の区切りのため)", () => {
    expect(folderNameError("a/b")).not.toBeNull();
  });

  it("打ち始める前は誤りにしない", () => {
    expect(folderNameError("")).toBeNull();
    expect(folderNameError("月次")).toBeNull();
  });
});

describe("folderOptions", () => {
  it("先頭は「フォルダなし」、子は親のすぐ後ろに並べる", () => {
    const got = folderOptions(["他", "集計/月次", "集計"]).map((o) => o.value);
    expect(got[0]).toBe("");
    expect(got.indexOf("集計/月次")).toBe(got.indexOf("集計") + 1);
    expect(got).toHaveLength(4);
  });

  it("区切りより先に並ぶ文字を含むフォルダが、親子の間に割り込まない", () => {
    const got = folderOptions(["集計 A", "集計/月次", "集計"]).map(
      (o) => o.value
    );
    expect(got.indexOf("集計/月次")).toBe(got.indexOf("集計") + 1);
  });

  it("階層の区切りを読みやすくする", () => {
    const got = folderOptions(["集計/月次"]);
    expect(got[1].label).toBe("集計 / 月次");
  });
});

describe("folderLabel", () => {
  it("ルートは「フォルダなし」と書く", () => {
    expect(folderLabel("")).toBe("(フォルダなし)");
  });
});

describe("canImport", () => {
  it("エディタが空か、同じ中身なら押せない", () => {
    expect(canImport("", "SELECT 1")).toBe(false);
    expect(canImport("SELECT 1", "SELECT 1")).toBe(false);
  });

  it("違う中身なら押せる", () => {
    expect(canImport("SELECT 2", "SELECT 1")).toBe(true);
  });
});

describe("foldersToOpen", () => {
  it("保存したフォルダと、その祖先を開く", () => {
    expect(foldersToOpen("集計/月次/店舗")).toEqual([
      "集計",
      "集計/月次",
      "集計/月次/店舗",
    ]);
    expect(foldersToOpen("")).toEqual([]);
  });
});

describe("folderExists", () => {
  it("同じパスのフォルダがあるか", () => {
    expect(folderExists(["集計"], "集計")).toBe(true);
    expect(folderExists(["集計"], "集計/月次")).toBe(false);
  });
});

describe("fmtUpdated", () => {
  it("年月日と時刻を出す", () => {
    const ms = new Date(2026, 8, 24, 9, 5).getTime();
    expect(fmtUpdated(ms)).toBe("2026/09/24 09:05");
  });

  it("記録が無ければ空", () => {
    expect(fmtUpdated(0)).toBe("");
  });
});
