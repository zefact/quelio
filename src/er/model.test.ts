import { describe, expect, it } from "vitest";
import {
  buildEdges,
  buildNodes,
  charUnits,
  colMarker,
  colTracks,
  edgeKey,
  nodeWidth,
} from "./model";
import { NODE_HEAD_H, NODE_PAD_B, ROW_H } from "./model";
import type { ColumnInfo, FkInfo, SchemaEntry } from "../types";

describe("寸法の定数", () => {
  /*
   * 線のつなぎ目 (anchorY) と表示位置がこの値で決まる。
   * CSS側は --er-row-h で受け取るので、ここが唯一の基準
   */
  it("見た目の基準になる値", () => {
    expect(NODE_HEAD_H).toBe(26);
    expect(ROW_H).toBe(17);
    expect(NODE_PAD_B).toBe(6);
  });
});

/** テスト用のカラム */
const col = (name: string, o: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  colType: "int",
  nullable: true,
  ...o,
});

/** テスト用のテーブル */
const entry = (
  name: string,
  columns: ColumnInfo[],
  tableComment = ""
): SchemaEntry => ({
  table: { name, tableType: "BASE TABLE" },
  detail: {
    columns,
    indexes: [],
    foreignKeys: [],
    info: tableComment ? [["コメント", tableComment]] : [],
  },
});

describe("colMarker", () => {
  it("NOT NULLとPKは●、NULL許容は○", () => {
    const base = { name: "a", type: "", logical: "" };
    expect(colMarker({ ...base, isPk: false, notNull: true })).toBe("● ");
    expect(colMarker({ ...base, isPk: true, notNull: false })).toBe("● ");
    expect(colMarker({ ...base, isPk: false, notNull: false })).toBe("○ ");
  });
});

describe("edgeKey", () => {
  it("両端のテーブルとカラムで一意になる", () => {
    const k = edgeKey({
      from: "a",
      fromColumn: "x",
      to: "b",
      toColumn: "y",
    });
    expect(k).toBe("a.x->b.y");
    // 向きが逆なら別のキー
    expect(
      edgeKey({ from: "b", fromColumn: "y", to: "a", toColumn: "x" })
    ).not.toBe(k);
  });
});

describe("charUnits", () => {
  it("全角は2文字ぶんで数える", () => {
    expect(charUnits("abc")).toBe(3);
    expect(charUnits("あいう")).toBe(6);
    expect(charUnits("a会員")).toBe(5);
    expect(charUnits("")).toBe(0);
  });
});

describe("nodeWidth", () => {
  it("短くても下限、長くても上限に収まる", () => {
    expect(nodeWidth("t", "", [])).toBe(140);
    expect(nodeWidth("t".repeat(500), "", [])).toBe(760);
  });

  it("カラムが増えるほど広くなる", () => {
    const narrow = nodeWidth("t", "", [
      { name: "id", isPk: true, notNull: true, type: "", logical: "" },
    ]);
    const wide = nodeWidth("t", "", [
      {
        name: "very_long_column_name_here",
        isPk: true,
        notNull: true,
        type: "varchar(255)",
        logical: "とても長い日本語名",
      },
    ]);
    expect(wide).toBeGreaterThan(narrow);
  });
});

describe("colTracks", () => {
  it("最後の列だけ右端まで伸ばす", () => {
    expect(colTracks(false, false)).toBe("minmax(max-content, 1fr)");
    expect(colTracks(true, false)).toBe(
      "max-content minmax(max-content, 1fr)"
    );
    expect(colTracks(true, true)).toBe(
      "max-content max-content minmax(max-content, 1fr)"
    );
  });
});

describe("buildNodes", () => {
  const entries = [
    entry(
      "users",
      [
        col("id", { key: "PRI", nullable: false, comment: "ID（識別子）" }),
        col("name", { colType: "varchar(50)", comment: "名前（氏名）" }),
      ],
      "利用者（ユーザー）"
    ),
  ];

  it("PKだけ表示のときはPK以外を落とす", () => {
    const [n] = buildNodes(entries, false, false, false, "（");
    expect(n.columns.map((c) => c.name)).toEqual(["id"]);
    // 表示オプションOFFなら型も日本語名も空
    expect(n.columns[0].type).toBe("");
    expect(n.logical).toBe("");
  });

  it("全カラム表示・型・日本語名を出す", () => {
    const [n] = buildNodes(entries, true, true, true, "（");
    expect(n.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(n.columns[1].type).toBe("varchar(50)");
    expect(n.columns[1].logical).toBe("名前");
    expect(n.logical).toBe("利用者");
  });

  it("高さはヘッダ+行数×行高+下余白", () => {
    const [one] = buildNodes(entries, false, false, false, "（");
    const [two] = buildNodes(entries, true, false, false, "（");
    expect(one.h).toBe(NODE_HEAD_H + 1 * ROW_H + NODE_PAD_B);
    expect(two.h).toBe(NODE_HEAD_H + 2 * ROW_H + NODE_PAD_B);
  });
});

describe("buildEdges", () => {
  it("FK制約から線を作る", () => {
    const entries = [
      entry("orders", [col("id", { key: "PRI" }), col("user_id")]),
      entry("users", [col("id", { key: "PRI" })]),
    ];
    const fks: FkInfo[] = [
      { table: "orders", column: "user_id", refTable: "users", refColumn: "id" },
    ];
    const edges = buildEdges(entries, fks);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      from: "orders",
      to: "users",
      fromColumn: "user_id",
      toColumn: "id",
      guessed: false,
    });
  });

  it("一覧に無いテーブルへのFKは無視する", () => {
    const entries = [entry("orders", [col("user_id")])];
    const fks: FkInfo[] = [
      { table: "orders", column: "user_id", refTable: "users", refColumn: "id" },
    ];
    expect(buildEdges(entries, fks)).toEqual([]);
  });

  it("xxx_id から推測する (m_ / 複数形も見る)", () => {
    const entries = [
      entry("orders", [col("id", { key: "PRI" }), col("user_id")]),
      entry("m_user", [col("id", { key: "PRI" })]),
    ];
    const edges = buildEdges(entries, []);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      from: "orders",
      to: "m_user",
      fromColumn: "user_id",
      toColumn: "id",
      guessed: true,
    });
  });

  it("FKがある組み合わせは推測で重複させない", () => {
    // FKは owner_id で張り、推測されうる user_id も別に持たせる。
    // ラベルが違うので「同じ線」としては潰れず、
    // 組み合わせ単位で止めているかどうかを確かめられる
    const entries = [
      entry("orders", [
        col("id", { key: "PRI" }),
        col("owner_id"),
        col("user_id"),
      ]),
      entry("user", [col("id", { key: "PRI" })]),
    ];
    const fks: FkInfo[] = [
      { table: "orders", column: "owner_id", refTable: "user", refColumn: "id" },
    ];
    const edges = buildEdges(entries, fks);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ fromColumn: "owner_id", guessed: false });
  });

  it("t_接頭辞・複数形からも推測する", () => {
    const guess = (target: string) => {
      const edges = buildEdges(
        [
          entry("logs", [col("user_id")]),
          entry(target, [col("id", { key: "PRI" })]),
        ],
        []
      );
      return edges.map((e) => e.to);
    };
    expect(guess("t_user")).toEqual(["t_user"]);
    expect(guess("users")).toEqual(["users"]);
    expect(guess("m_user")).toEqual(["m_user"]);
    // 関係ない名前には線を引かない
    expect(guess("account")).toEqual([]);
  });

  it("複合PKを全て持つテーブルを子とみなす", () => {
    const entries = [
      entry("order_items", [col("order_id"), col("item_id"), col("qty")]),
      entry("order_item_prices", [
        col("order_id", { key: "PRI" }),
        col("item_id", { key: "PRI" }),
      ]),
    ];
    const edges = buildEdges(entries, []);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      from: "order_items",
      to: "order_item_prices",
      label: "order_id, item_id",
      guessed: true,
    });
  });

  it("PKが id 単独のテーブルは複合PK推測の対象にしない", () => {
    const entries = [
      entry("a", [col("id")]),
      entry("b", [col("id", { key: "PRI" })]),
    ];
    // aは "id" を持つが、bのPKが id 単独なのでルール1では線を作らない
    expect(buildEdges(entries, []).filter((e) => e.to === "b")).toEqual([]);
  });

  it("自分自身への線は作らない", () => {
    const entries = [
      entry("nodes", [col("id", { key: "PRI" }), col("nodes_id")]),
    ];
    expect(buildEdges(entries, [])).toEqual([]);
  });
});
