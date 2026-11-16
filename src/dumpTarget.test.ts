import { describe, expect, it } from "vitest";
import {
  badFileName,
  badPattern,
  DEFAULT_NAME_PATTERN,
  expandPattern,
  folderName,
  joinPath,
  splitPath,
  withSqlExt,
} from "./dumpTarget";

describe("保存先のパス", () => {
  it("フォルダの区切りに合わせてつなぐ", () => {
    expect(joinPath("/Users/me/Downloads", "a.sql")).toBe("/Users/me/Downloads/a.sql");
    expect(joinPath("/Users/me/Downloads/", "a.sql")).toBe("/Users/me/Downloads/a.sql");
    expect(joinPath("C:\\Users\\me\\Downloads", "a.sql")).toBe("C:\\Users\\me\\Downloads\\a.sql");
    expect(joinPath("/", "a.sql")).toBe("/a.sql");
  });

  it("フォルダとファイル名に分ける", () => {
    expect(splitPath("/Users/me/b/a.sql")).toEqual({ dir: "/Users/me/b", name: "a.sql" });
    expect(splitPath("C:\\x\\a.sql")).toEqual({ dir: "C:\\x", name: "a.sql" });
    expect(splitPath("/a.sql")).toEqual({ dir: "/", name: "a.sql" });
  });

  it("フォルダの名前", () => {
    expect(folderName("/Users/me/Downloads")).toBe("Downloads");
    expect(folderName("C:\\Users\\me\\Backups\\")).toBe("Backups");
    expect(folderName("/")).toBe("/");
  });

  it("ファイル名を確かめる", () => {
    expect(badFileName("a.sql")).toBeNull();
    expect(badFileName("  ")).not.toBeNull();
    expect(badFileName("x/y.sql")).not.toBeNull();
    expect(badFileName("..")).not.toBeNull();
  });
});

describe("withSqlExt", () => {
  it("拡張子が無ければ .sql を付ける", () => {
    expect(withSqlExt("backup")).toBe("backup.sql");
    expect(withSqlExt("a.dump")).toBe("a.dump");
    expect(withSqlExt(".hidden")).toBe(".hidden.sql");
  });
});

describe("ファイル名のパターン", () => {
  const vars = { db: "shop", conn: "本番/レプリカ", mode: "full", tables: ["users"] };
  const now = new Date(2026, 10, 6, 9, 5, 3);

  it("既定のパターンは DB名_日付_時刻.sql", () => {
    expect(expandPattern(DEFAULT_NAME_PATTERN, vars, now)).toBe("shop_20261106_090503.sql");
  });

  it("細かい日時や接続名も使える (区切りは _ にする)", () => {
    expect(expandPattern("{conn}-{yyyy}-{MM}-{dd}_{HH}{mm}", vars, now)).toBe(
      "本番_レプリカ-2026-11-06_0905.sql"
    );
  });

  it("テーブル名は1つのときだけ入れ、複数なら区切りごと省く", () => {
    const many = { ...vars, tables: ["a", "b", "c"] };
    expect(expandPattern("{db}_{table}_{date}", vars, now)).toBe("shop_users_20261106.sql");
    expect(expandPattern("{db}_{table}_{date}", many, now)).toBe("shop_20261106.sql");
    expect(expandPattern("{table}-{db}", many, now)).toBe("shop.sql");
    expect(expandPattern("{db}_{table}", many, now)).toBe("shop.sql");
    // 全部空になったらDB名にする
    expect(expandPattern("{table}", many, now)).toBe("shop.sql");
  });

  it("拡張子を書けばそのまま", () => {
    expect(expandPattern("{db}_{mode}.dump", vars, now)).toBe("shop_full.dump");
  });

  it("誤りを見つける", () => {
    expect(badPattern(DEFAULT_NAME_PATTERN)).toBeNull();
    expect(badPattern("{db}_{foo}")).toBe("使えない置き換えがあります: {foo}");
    expect(badPattern("{db}/{date}")).not.toBeNull();
    expect(badPattern(" ")).not.toBeNull();
  });
});
