import { describe, expect, it } from "vitest";
import {
  joinComment,
  joinType,
  normalizeExtra,
  riskyChanges,
  specOfColumn,
  splitType,
  toDraft,
  withBase,
  withSize,
} from "./columnDraft";
import type { ColumnInfo, ColumnSpec } from "../types";

const col = (over: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name: "c",
  colType: "varchar(10)",
  nullable: true,
  ...over,
});

const spec = (over: Partial<ColumnSpec> = {}): ColumnSpec => ({
  name: "c",
  colType: "varchar(10)",
  nullable: true,
  default: "",
  comment: "",
  extra: "",
  collation: "",
  ...over,
});

describe("splitType / joinType", () => {
  it("サイズを切り出して戻せる", () => {
    expect(splitType("varchar(100)")).toEqual({ base: "varchar", size: "100" });
    expect(splitType("int")).toEqual({ base: "int", size: "" });
    expect(splitType("decimal(10,2) unsigned")).toEqual({
      base: "decimal unsigned",
      size: "10,2",
    });
    expect(splitType("timestamp(3) without time zone")).toEqual({
      base: "timestamp without time zone",
      size: "3",
    });
  });

  it("修飾語の手前にサイズを入れる", () => {
    expect(joinType("varchar", "255")).toBe("varchar(255)");
    expect(joinType("decimal unsigned", "10,2")).toBe("decimal(10,2) unsigned");
    expect(joinType("timestamp without time zone", "3")).toBe(
      "timestamp(3) without time zone"
    );
    // "varying" は型名の一部なので分けない
    expect(joinType("character varying", "255")).toBe(
      "character varying(255)"
    );
    expect(joinType("int", "")).toBe("int");
  });

  it("往復しても形が変わらない", () => {
    for (const t of [
      "varchar(100)",
      "int",
      "decimal(10,2) unsigned",
      "timestamp(3) without time zone",
      "character varying(255)",
    ]) {
      const { base, size } = splitType(t);
      expect(joinType(base, size)).toBe(t);
    }
  });

  it("片方だけ差し替えられる", () => {
    expect(withSize("varchar(100)", "255")).toBe("varchar(255)");
    expect(withBase("varchar(100)", "char")).toBe("char(100)");
  });
});

describe("normalizeExtra", () => {
  it("扱える属性だけ取り出す", () => {
    expect(normalizeExtra("auto_increment")).toBe("AUTO_INCREMENT");
    expect(normalizeExtra("DEFAULT_GENERATED on update CURRENT_TIMESTAMP")).toBe(
      "ON UPDATE CURRENT_TIMESTAMP"
    );
    expect(normalizeExtra("VIRTUAL GENERATED")).toBe("");
    expect(normalizeExtra(undefined)).toBe("");
  });
});

describe("joinComment", () => {
  it("区切り文字があれば閉じ括弧も付ける", () => {
    expect(joinComment("名前", "補足", "（")).toBe("名前（補足）");
    expect(joinComment("名前", "", "（")).toBe("名前");
    expect(joinComment("", "補足", "（")).toBe("（補足）");
    // 区切りが無ければ空白でつなぐ
    expect(joinComment("名前", "補足", "")).toBe("名前 補足");
  });
});

describe("toDraft / specOfColumn", () => {
  it("空文字のデフォルトは '' と表して指定なしと区別する", () => {
    expect(toDraft(col({ default: "" }), "（").default).toBe("''");
    expect(toDraft(col({ default: undefined }), "（").default).toBe("");
    expect(specOfColumn(col({ default: "" })).default).toBe("''");
  });

  it("コメントを論理名と補足に分ける", () => {
    const d = toDraft(col({ comment: "名前（表示用）" }), "（");
    expect(d.logical).toBe("名前");
    expect(d.note).toBe("表示用");
    expect(d.comment).toBe("名前（表示用）");
  });
});

describe("riskyChanges", () => {
  it("型が変わる・サイズが縮む・NOT NULL化・照合順序の変更を挙げる", () => {
    expect(
      riskyChanges(spec({ colType: "varchar(10)" }), spec({ colType: "int" }))
    ).toHaveLength(1);
    expect(
      riskyChanges(
        spec({ colType: "varchar(100)" }),
        spec({ colType: "varchar(10)" })
      )
    ).toHaveLength(1);
    expect(
      riskyChanges(spec({ nullable: true }), spec({ nullable: false }))
    ).toHaveLength(1);
    expect(
      riskyChanges(
        spec({ collation: "utf8mb4_bin" }),
        spec({ collation: "utf8mb4_general_ci" })
      )
    ).toHaveLength(1);
  });

  it("広げる・変えない場合は何も出ない", () => {
    expect(
      riskyChanges(
        spec({ colType: "varchar(10)" }),
        spec({ colType: "varchar(100)" })
      )
    ).toEqual([]);
    expect(riskyChanges(spec(), spec())).toEqual([]);
    expect(
      riskyChanges(spec({ nullable: false }), spec({ nullable: true }))
    ).toEqual([]);
    // 小数部だけ増えるのは縮小ではない
    expect(
      riskyChanges(
        spec({ colType: "decimal(10,2)" }),
        spec({ colType: "decimal(10,4)" })
      )
    ).toEqual([]);
  });

  it("複合的な変更はまとめて挙げる", () => {
    const out = riskyChanges(
      spec({ colType: "varchar(100)", nullable: true }),
      spec({ colType: "varchar(10)", nullable: false })
    );
    expect(out).toHaveLength(2);
  });
});
