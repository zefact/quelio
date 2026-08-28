import { describe, expect, it } from "vitest";
import {
  columnType,
  firstColumns,
  isEmptyRow,
  moveColumn,
  newColumn,
  patchColumn,
  toNewTable,
  toSpec,
  validateDraft,
} from "./newTable";

describe("columnType", () => {
  it("括弧の中身があれば付ける", () => {
    expect(columnType(newColumn({ type: "varchar", args: "100" }))).toBe(
      "varchar(100)"
    );
  });

  it("空なら型名だけにする", () => {
    expect(columnType(newColumn({ type: "text", args: " " }))).toBe("text");
  });
});

describe("toSpec", () => {
  it("空欄は送らない (未指定として扱わせる)", () => {
    const spec = toSpec(newColumn({ name: " id ", type: "int" }));
    expect(spec).toEqual({
      name: "id",
      colType: "int",
      nullable: true,
      default: undefined,
      comment: undefined,
      extra: undefined,
    });
  });

  it("自動採番はEXTRAとして送る", () => {
    const spec = toSpec(newColumn({ name: "id", type: "int", autoIncrement: true }));
    expect(spec.extra).toBe("auto_increment");
  });
});

describe("toNewTable", () => {
  it("主キーの列を並び順のまま集める", () => {
    const columns = [
      newColumn({ name: "a", type: "int", primaryKey: true }),
      newColumn({ name: "b", type: "int" }),
      newColumn({ name: "c", type: "int", primaryKey: true }),
    ];
    const t = toNewTable({ name: "t", columns });
    expect(t.primaryKey).toEqual(["a", "c"]);
    expect(t.columns).toHaveLength(3);
  });

  it("何も入っていない行は送らない", () => {
    const t = toNewTable({
      name: "t",
      columns: [newColumn({ name: "a", type: "int" }), newColumn()],
    });
    expect(t.columns).toHaveLength(1);
  });

  it("空文字の指定は未指定にする", () => {
    const t = toNewTable({
      name: " t ",
      schema: "  ",
      charset: "",
      columns: [newColumn({ name: "a", type: "int" })],
    });
    expect(t.name).toBe("t");
    expect(t.schema).toBeUndefined();
    expect(t.charset).toBeUndefined();
  });
});

describe("validateDraft", () => {
  const ok = [newColumn({ name: "id", type: "int" })];

  it("テーブル名が要る", () => {
    expect(validateDraft("  ", ok)).toContain("テーブル名");
  });

  it("カラムが1つも無いと作れない", () => {
    expect(validateDraft("t", [newColumn()])).toContain("カラムを1つ以上");
  });

  it("型を選んでいない行を教える", () => {
    expect(validateDraft("t", [newColumn({ name: "id" })])).toContain("型を選んで");
  });

  it("大文字小文字が違うだけの重複も見つける", () => {
    const cols = [
      newColumn({ name: "id", type: "int" }),
      newColumn({ name: "ID", type: "int" }),
    ];
    expect(validateDraft("t", cols)).toContain("重複");
  });

  it("問題が無ければnull", () => {
    expect(validateDraft("t", ok)).toBeNull();
  });
});

describe("moveColumn", () => {
  const cols = [
    newColumn({ name: "a" }),
    newColumn({ name: "b" }),
    newColumn({ name: "c" }),
  ];

  it("入れ替える", () => {
    expect(moveColumn(cols, 0, 1).map((c) => c.name)).toEqual(["b", "a", "c"]);
  });

  it("端では動かさない", () => {
    expect(moveColumn(cols, 0, -1)).toBe(cols);
    expect(moveColumn(cols, 2, 1)).toBe(cols);
  });
});

describe("patchColumn", () => {
  const cols = [newColumn({ id: "x", name: "id", type: "int" })];

  it("自動採番にすると主キー・NOT NULLもそろえる", () => {
    const next = patchColumn(cols, "x", { autoIncrement: true });
    expect(next[0].primaryKey).toBe(true);
    expect(next[0].nullable).toBe(false);
  });

  it("NULL可に戻すと主キーと自動採番を外す", () => {
    const on = patchColumn(cols, "x", { autoIncrement: true });
    const off = patchColumn(on, "x", { nullable: true });
    expect(off[0].primaryKey).toBe(false);
    expect(off[0].autoIncrement).toBe(false);
  });

  it("他の行はそのまま", () => {
    const two = [...cols, newColumn({ id: "y", name: "name" })];
    const next = patchColumn(two, "x", { name: "no" });
    expect(next[1]).toBe(two[1]);
  });
});

describe("firstColumns", () => {
  it("主キーのidと空の行から始める", () => {
    const cols = firstColumns("mysql");
    expect(cols[0].name).toBe("id");
    expect(cols[0].type).toBe("int");
    expect(cols[0].primaryKey).toBe(true);
    expect(isEmptyRow(cols[1])).toBe(true);
  });

  it("PostgreSQLとSQLiteはinteger", () => {
    expect(firstColumns("postgresql")[0].type).toBe("integer");
    expect(firstColumns("sqlite")[0].type).toBe("integer");
  });
});
