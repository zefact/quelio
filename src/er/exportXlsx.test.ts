import { describe, expect, it } from "vitest";
import { buildErSheet, glueAt } from "./exportXlsx";
import { toPaint } from "./xlsxModel";
import type { ErDrawInput } from "./drawing";
import type { ErColumn, ErNode } from "./model";

/** 文字幅は環境で変わるので、テストでは1文字7pxで固定する */
const measure = (text: string) => text.length * 7;

function col(name: string, type: string, o: Partial<ErColumn> = {}): ErColumn {
  return { name, type, isPk: false, notNull: false, logical: "", ...o };
}

function node(name: string, columns: ErColumn[]): ErNode {
  return { name, logical: "", columns, w: 200, h: 26 + columns.length * 17 + 6 };
}

const orders = node("orders", [
  col("id", "bigint", { isPk: true, notNull: true, logical: "注文ID" }),
  col("customer_id", "bigint", { notNull: true, color: "#ef4444" }),
]);
const customers = node("customers", [col("id", "bigint", { isPk: true })]);

function input(over: Partial<ErDrawInput> = {}): ErDrawInput {
  return {
    database: "app",
    nodes: [orders, customers],
    bounds: { w: 600, h: 400 },
    frames: [],
    edges: [
      {
        from: "orders",
        to: "customers",
        fromColumn: "customer_id",
        toColumn: "id",
        label: "",
        guessed: false,
      },
    ],
    // orders.customer_id の右辺 → customers.id の左辺
    edgeGeoms: [
      [
        [200, 51.5],
        [250, 51.5],
        [250, 134.5],
        [300, 134.5],
      ],
    ],
    edgeStyles: {},
    posOf: (name) => (name === "orders" ? { x: 0, y: 0 } : { x: 300, y: 100 }),
    verticalsExcept: () => [],
    light: false,
    ...over,
  };
}

describe("ER図のExcel書き出し", () => {
  it("線の端をカラム行につなぐ", () => {
    const s = buildErSheet(input(), measure);
    expect(s.edges).toHaveLength(1);
    expect(s.edges[0].from).toEqual({
      table: 0,
      target: { kind: "row", index: 1 },
      side: "right",
    });
    expect(s.edges[0].to).toEqual({
      table: 1,
      target: { kind: "row", index: 0 },
      side: "left",
    });
    // 凡例の高さと左余白だけずらす
    expect(s.edges[0].points[0]).toEqual([220, 81.5]);
    expect(s.tables[1]).toMatchObject({ x: 320, y: 130 });
  });

  it("上下の辺・見出しにもつなぐ", () => {
    const p = { x: 0, y: 0 };
    expect(glueAt(0, orders, p, [100, 0])?.side).toBe("top");
    expect(glueAt(0, orders, p, [100, orders.h])?.target).toEqual({ kind: "body" });
    expect(glueAt(0, orders, p, [0, 13])?.target).toEqual({ kind: "head" });
    expect(glueAt(0, orders, p, [50, 50])).toBeNull();
  });

  it("カラム行を 名前 / 型 / 日本語名 に分け、色を引き継ぐ", () => {
    const s = buildErSheet(input(), measure);
    const t = s.tables[0];
    // "● customer_id" = 13文字 → 91px。型は6文字 → 42px
    expect(t.tabs).toEqual([101, 153]);
    expect(t.rows[0].map((c) => c.text)).toEqual(["● id", "bigint", "注文ID"]);
    // 日本語名が空の行は後ろの区切りを省く
    expect(t.rows[1].map((c) => c.text)).toEqual(["● customer_id", "bigint"]);
    expect(t.rows[1][0].color).toBe("EF4444");
    // 主キーはライト配色のインディゴ
    expect(t.rows[0][0].color).toBe("4F46E5");
    // 日本語名は等幅にしない
    expect(t.rows[0][2].mono).toBe(false);
    // 日本語名のない表は区切りも1つ
    expect(s.tables[1].tabs).toEqual([38]);
  });

  it("枠とテキスト見出しを分けて出す", () => {
    const s = buildErSheet(
      input({
        frames: [
          { id: "a", label: "会員", style: "dashed", x: 0, y: 0, w: 100, h: 50, fill: "#22c55e" },
          { id: "b", kind: "text", label: "見出し", style: "none", x: 10, y: 10, w: 80, h: 30 },
        ],
      }),
      measure
    );
    expect(s.frames).toHaveLength(1);
    expect(s.frames[0]).toMatchObject({ dash: "dash", rounded: true, front: false });
    expect(s.frames[0].fill).toEqual({ rgb: "22C55E", alpha: 0.25 });
    expect(s.labels.map((l) => l.text)).toContain("見出し");
    expect(s.labels[0].text).toBe("Quelio ER図 — app");
  });

  it("CSSの色を読み取る", () => {
    expect(toPaint("rgba(99, 102, 241, 0.85)")).toEqual({ rgb: "6366F1", alpha: 0.85 });
    expect(toPaint("#ffffff", 0.5)).toEqual({ rgb: "FFFFFF", alpha: 0.5 });
    expect(toPaint("red")).toEqual({ rgb: "000000", alpha: 1 });
  });
});
