import { describe, expect, it } from "vitest";
import {
  checkErTable,
  emptyErTable,
  fromSchemaEntry,
  toSchemaEntry,
} from "./newTable";
import type { ErTableSpec } from "./newTable";

function spec(over: Partial<ErTableSpec> = {}): ErTableSpec {
  return {
    name: "m_user",
    logical: "利用者",
    columns: [
      { name: "user_id", type: "int", logical: "利用者ID", pk: true, notNull: true },
      { name: "name", type: "varchar(100)", logical: "氏名", pk: false, notNull: true },
    ],
    ...over,
  };
}

describe("入れた内容の確かめ", () => {
  it("そろっていれば通す", () => {
    expect(checkErTable(spec(), [])).toBeNull();
  });

  it("名前が無ければ断る", () => {
    expect(checkErTable(spec({ name: "  " }), [])).toContain("テーブル名");
  });

  it("すでにある名前は断る (大小は問わない)", () => {
    expect(checkErTable(spec(), ["M_USER"])).toContain("もう図にあります");
    // 自分以外に無ければ通る
    expect(checkErTable(spec(), ["t_work"])).toBeNull();
  });

  it("列が1つも無ければ断る", () => {
    expect(checkErTable(emptyErTable(), [])).toContain("テーブル名");
    expect(checkErTable(spec({ columns: [] }), [])).toContain("列を1つ以上");
  });

  it("同じ名前の列は断る", () => {
    const s = spec();
    const dup = spec({ columns: [s.columns[0], { ...s.columns[1], name: "USER_ID" }] });
    expect(checkErTable(dup, [])).toContain("同じ名前の列");
  });
});

describe("スキーマの形にする", () => {
  it("主キーと日本語名を持たせる", () => {
    const e = toSchemaEntry(spec());
    expect(e.table.name).toBe("m_user");
    expect(e.detail.info).toEqual([["コメント", "利用者"]]);
    expect(e.detail.columns[0]).toEqual({
      name: "user_id",
      colType: "int",
      nullable: false,
      key: "PRI",
      comment: "利用者ID",
    });
    expect(e.detail.columns[1].nullable).toBe(false);
    expect(e.detail.columns[1].key).toBe("");
  });

  it("名前が空の列は入れない", () => {
    const s = spec({
      columns: [
        ...spec().columns,
        { name: "  ", type: "int", logical: "", pk: false, notNull: false },
      ],
    });
    expect(toSchemaEntry(s).detail.columns).toHaveLength(2);
  });

  it("日本語名が無ければコメントを持たせない", () => {
    expect(toSchemaEntry(spec({ logical: "" })).detail.info).toEqual([]);
  });

  it("前後の空白は落とす", () => {
    const s = spec({ name: " m_user " });
    expect(toSchemaEntry(s).table.name).toBe("m_user");
  });
});

describe("入れ直せる形へ戻す", () => {
  it("入れた内容がそのまま戻る", () => {
    const s = spec();
    expect(fromSchemaEntry(toSchemaEntry(s), ":")).toEqual(s);
  });

  it("主キーは NOT NULL として戻る", () => {
    const s = spec({
      columns: [
        { name: "id", type: "int", logical: "", pk: true, notNull: false },
      ],
    });
    expect(fromSchemaEntry(toSchemaEntry(s), ":").columns[0].notNull).toBe(true);
  });

  it("コメントの区切りより後ろは日本語名にしない", () => {
    const e = toSchemaEntry(spec({ logical: "利用者" }));
    e.detail.info = [["コメント", "利用者: 退会者も含む"]];
    expect(fromSchemaEntry(e, ":").logical).toBe("利用者");
  });
});
