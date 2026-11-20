import { describe, expect, it } from "vitest";
import { dialogDefaultPath, exportDirMode, settingsAfterExport } from "./exportDir";
import { DEFAULT_APP_SETTINGS } from "./hooks/useAppSettings";
import type { AppSettings } from "./types";

const base = (patch: Partial<AppSettings>): AppSettings => ({
  ...DEFAULT_APP_SETTINGS,
  ...patch,
});

describe("exportDirMode", () => {
  it("選んであればその決め方", () => {
    expect(exportDirMode({ exportDirMode: "fixed", downloadDir: "" })).toBe("fixed");
    expect(exportDirMode({ exportDirMode: "last", downloadDir: "/a" })).toBe("last");
  });

  it("古い設定でフォルダを決めてあった人は「決まったフォルダ」", () => {
    expect(exportDirMode({ exportDirMode: "", downloadDir: "/Users/me/out" })).toBe(
      "fixed"
    );
  });

  it("古い設定でフォルダを決めていない人は「最後に使ったフォルダ」", () => {
    expect(exportDirMode({ exportDirMode: "", downloadDir: "" })).toBe("last");
    expect(exportDirMode({ exportDirMode: "", downloadDir: "  " })).toBe("last");
  });
});

describe("dialogDefaultPath", () => {
  it("フォルダとファイル名をつなぐ", () => {
    expect(dialogDefaultPath("/Users/me/Downloads", "a.xlsx")).toBe(
      "/Users/me/Downloads/a.xlsx"
    );
    expect(dialogDefaultPath("/Users/me/Downloads/", "a.xlsx")).toBe(
      "/Users/me/Downloads/a.xlsx"
    );
  });

  it("Windows の区切りに合わせる", () => {
    expect(dialogDefaultPath("C:\\Users\\me\\Downloads", "a.json")).toBe(
      "C:\\Users\\me\\Downloads\\a.json"
    );
  });

  it("フォルダが分からなければファイル名だけ", () => {
    expect(dialogDefaultPath("", "a.json")).toBe("a.json");
  });
});

describe("settingsAfterExport", () => {
  it("「最後に使ったフォルダ」なら選んだフォルダを覚え、決め方も書いておく", () => {
    const s = base({ downloadDir: "", exportDirMode: "" });
    const next = settingsAfterExport(s, "/Users/me/Downloads", "/Users/me/work/a.xlsx");
    expect(next?.downloadDir).toBe("/Users/me/work");
    // フォルダが入っても「決まったフォルダ」に読み替わらないこと
    expect(next?.exportDirMode).toBe("last");
    expect(next && exportDirMode(next)).toBe("last");
    // ほかの設定はそのまま
    expect(next?.queryTimeoutSecs).toBe(s.queryTimeoutSecs);
  });

  it("いまと同じフォルダなら変えない", () => {
    const s = base({ downloadDir: "/Users/me/work", exportDirMode: "last" });
    expect(settingsAfterExport(s, "/Users/me/work", "/Users/me/work/a.xlsx")).toBeNull();
    expect(settingsAfterExport(s, "/Users/me/work/", "/Users/me/work/b.json")).toBeNull();
  });

  it("設定が空でダウンロードフォルダに書いたなら変えない", () => {
    const s = base({ downloadDir: "", exportDirMode: "last" });
    expect(
      settingsAfterExport(s, "/Users/me/Downloads", "/Users/me/Downloads/a.xlsx")
    ).toBeNull();
  });

  it("「決まったフォルダ」なら別のフォルダに書いても変えない", () => {
    const s = base({ downloadDir: "/Users/me/out", exportDirMode: "fixed" });
    expect(settingsAfterExport(s, "/Users/me/out", "/tmp/a.xlsx")).toBeNull();
    // 古い設定でフォルダを決めてあった人も同じ
    const old = base({ downloadDir: "/Users/me/out", exportDirMode: "" });
    expect(settingsAfterExport(old, "/Users/me/out", "/tmp/a.xlsx")).toBeNull();
  });

  it("フォルダの無いパスは覚えない", () => {
    const s = base({ exportDirMode: "last" });
    expect(settingsAfterExport(s, "/Users/me/Downloads", "a.xlsx")).toBeNull();
  });

  it("Windows のパスも扱える", () => {
    const s = base({ exportDirMode: "last" });
    expect(
      settingsAfterExport(s, "C:\\Users\\me\\Downloads", "D:\\work\\a.sql")?.downloadDir
    ).toBe("D:\\work");
  });
});
