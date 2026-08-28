import { describe, expect, it } from "vitest";
import { autoMap, checkMapping, normalizeName } from "./mapping";
import type { ColumnInfo } from "../../types";

/** テスト用の列を作る */
function col(name: string, over: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, colType: "text", nullable: true, ...over };
}

describe("normalizeName", () => {
  it("大小文字と区切り記号を無視する", () => {
    expect(normalizeName(" User_Name ")).toBe("username");
    expect(normalizeName("user-name")).toBe("username");
  });
});

describe("autoMap", () => {
  it("見出し名が同じ列へ割り当てる", () => {
    expect(autoMap(["id", "User Name"], ["id", "user_name"], true)).toEqual([
      "id",
      "user_name",
    ]);
  });

  it("見当たらない列はnullにする", () => {
    expect(autoMap(["id", "nickname"], ["id", "name"], true)).toEqual([
      "id",
      null,
    ]);
  });

  it("同じ取り込み先を2回使わない", () => {
    expect(autoMap(["id", "ID"], ["id", "name"], true)).toEqual(["id", null]);
  });

  it("見出し行が無ければ並び順で当てる", () => {
    expect(autoMap(["1列目", "2列目", "3列目"], ["id", "name"], false)).toEqual(
      ["id", "name", null]
    );
  });
});

describe("checkMapping", () => {
  const cols = [
    col("id", { nullable: false, key: "PRI", extra: "auto_increment" }),
    col("name", { nullable: false }),
    col("memo"),
  ];

  it("1つも選んでいなければエラーにする", () => {
    const r = checkMapping([null, null], cols, "append", "mysql");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
  });

  it("同じ列を2回選んだらエラーにする", () => {
    const r = checkMapping(["name", "name"], cols, "append", "mysql");
    expect(r.some((i) => i.level === "error")).toBe(true);
  });

  it("必須の列が抜けていたら知らせる", () => {
    const r = checkMapping(["memo"], cols, "append", "mysql");
    expect(r).toEqual([
      { level: "warn", message: "値が必須の列が未選択です: name" },
    ]);
  });

  it("自動採番の列は未選択でも構わない", () => {
    expect(checkMapping(["name"], cols, "append", "mysql")).toEqual([]);
  });

  it("空文字の既定値も既定値として扱う", () => {
    const c = [col("memo", { nullable: false, default: "" })];
    expect(checkMapping(["memo"], c, "append", "mysql")).toEqual([]);
  });

  it("postgresqlのidentity列は未選択でも構わない", () => {
    const c = [
      col("id", { nullable: false, key: "PRI", extra: "identity by default" }),
      col("name", { nullable: false }),
    ];
    expect(checkMapping(["name"], c, "append", "mysql")).toEqual([]);
  });

  it("sqliteの整数の主キーは未選択でも構わない", () => {
    const c = [
      col("id", { nullable: false, key: "PRI", colType: "INTEGER" }),
      col("name", { nullable: false }),
    ];
    expect(checkMapping(["name"], c, "append", "sqlite")).toEqual([]);
    // 他のDBでは同じ形でも自動採番とは限らないので、未選択なら知らせる
    expect(checkMapping(["name"], c, "append", "postgresql")).toEqual([
      { level: "warn", message: "値が必須の列が未選択です: id" },
    ]);
  });

  it("mysqlの既定値式の列を生成列と取り違えない", () => {
    const c = [
      col("id", { nullable: false, key: "PRI", extra: "auto_increment" }),
      col("created_at", {
        nullable: false,
        default: "CURRENT_TIMESTAMP",
        extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP",
      }),
    ];
    expect(checkMapping(["created_at"], c, "append", "mysql")).toEqual([]);
  });

  it("mysqlの非表示列の書き方でも生成列と分かる", () => {
    const c = [
      col("total", { nullable: false, extra: "STORED GENERATED, INVISIBLE" }),
      col("name", { nullable: false }),
    ];
    const r = checkMapping(["total", "name"], c, "append", "mysql");
    expect(r.some((i) => i.level === "error")).toBe(true);
  });

  it("生成列へは取り込めない", () => {
    const c = [
      col("total", { nullable: false, extra: "STORED GENERATED" }),
      col("name", { nullable: false }),
    ];
    const r = checkMapping(["total", "name"], c, "append", "mysql");
    expect(r.some((i) => i.level === "error")).toBe(true);
  });

  it("dbが値を決める列へは取り込めない", () => {
    const c = [
      col("id", { nullable: false, key: "PRI", extra: "identity always" }),
      col("name", { nullable: false }),
    ];
    const r = checkMapping(["id", "name"], c, "append", "postgresql");
    expect(r.some((i) => i.level === "error")).toBe(true);
  });

  it("重複を飛ばすのに主キーが無ければ知らせる", () => {
    const r = checkMapping(["name"], cols, "skip", "mysql");
    expect(r.map((i) => i.message)).toContain(
      "重複の判定に使う主キーが未選択です: id"
    );
  });

  it("主キーが無いテーブルでは重複の判定ができないと知らせる", () => {
    const noPk = [col("name", { nullable: false }), col("memo")];
    const r = checkMapping(["name"], noPk, "replace", "mysql");
    expect(r.some((i) => i.message.includes("主キーが無い"))).toBe(true);
  });
});
