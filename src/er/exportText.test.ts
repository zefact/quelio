import { describe, expect, it } from "vitest";
import { toMermaid, toPlantUml } from "./exportText";
import type { ErTextInput } from "./exportText";
import type { ErColumn, ErEdge, ErNode } from "./model";

function col(
  name: string,
  type: string,
  o: Partial<ErColumn> = {}
): ErColumn {
  return { name, type, isPk: false, notNull: false, logical: "", ...o };
}

function node(name: string, logical: string, columns: ErColumn[]): ErNode {
  return { name, logical, columns, w: 0, h: 0 };
}

function edge(o: Partial<ErEdge> = {}): ErEdge {
  return {
    from: "orders",
    to: "customers",
    fromColumn: "customer_id",
    toColumn: "id",
    label: "customer_id → id",
    guessed: false,
    ...o,
  };
}

function input(): ErTextInput {
  return {
    database: "app",
    nodes: [
      node("orders", "注文", [
        col("id", "bigint", { isPk: true, notNull: true, logical: "注文ID" }),
        col("customer_id", "bigint", { notNull: true }),
        col("memo", "varchar(100)"),
      ]),
      node("customers", "顧客", [
        col("id", "bigint", { isPk: true, notNull: true }),
      ]),
    ],
    edges: [edge()],
  };
}

describe("Mermaid", () => {
  it("テーブルとカラムを書き出す", () => {
    const out = toMermaid(input());
    expect(out).toContain("erDiagram");
    // 日本語名があれば添える (記号が入るので引用符で囲む)
    expect(out).toContain('"orders (注文)" {');
    expect(out).toContain("bigint id PK \"注文ID\"");
    expect(out).toContain("varchar(100) memo");
  });

  it("参照しているカラムにFKを付ける", () => {
    expect(toMermaid(input())).toContain("bigint customer_id FK");
  });

  it("参照を「子 → 親」で書き、NOT NULLかで記号を変える", () => {
    const v = input();
    expect(toMermaid(v)).toContain(
      '"orders (注文)" }|--|| "customers (顧客)" : "customer_id → id"'
    );
    // NULL許容なら「0件以上」
    v.nodes[0].columns[1].notNull = false;
    expect(toMermaid(v)).toContain('"orders (注文)" }o--|| "customers (顧客)"');
  });

  it("名前からの推測は点線にする", () => {
    const v = input();
    v.edges = [edge({ guessed: true })];
    expect(toMermaid(v)).toContain("}|..||");
  });

  it("英数字だけの名前は引用符で囲まない", () => {
    const v = input();
    v.nodes.forEach((n) => (n.logical = ""));
    const out = toMermaid(v);
    expect(out).toContain("    orders {");
    expect(out).toContain("orders }|--|| customers");
  });

  it("型が空でも書ける (Mermaidは型が要るため)", () => {
    const v = input();
    v.nodes[0].columns[2].type = "";
    expect(toMermaid(v)).toContain("unknown memo");
  });

  it("図に無いテーブルへの参照は書かない", () => {
    const v = input();
    v.edges = [edge({ to: "居ない" })];
    expect(toMermaid(v)).not.toContain("居ない");
  });
});

describe("PlantUML", () => {
  it("開始と終了で挟み、別名は記号を含まない形にする", () => {
    const out = toPlantUml(input());
    expect(out.startsWith("@startuml")).toBe(true);
    expect(out.trimEnd().endsWith("@enduml")).toBe(true);
    expect(out).toContain('entity "orders (注文)" as orders {');
  });

  it("主キーとそれ以外を区切る", () => {
    const out = toPlantUml(input());
    expect(out).toContain("* id : bigint <<PK>>");
    expect(out).toContain("  --");
    expect(out).toContain("* customer_id : bigint <<FK>>");
    // NULL許容の列には印を付けない
    expect(out).toContain("    memo : varchar(100)");
  });

  it("参照を書く", () => {
    expect(toPlantUml(input())).toContain(
      'orders }|--|| customers : "customer_id → id"'
    );
  });

  it("記号を含むテーブル名でも別名は安全な形にする", () => {
    const v = input();
    v.nodes[0].name = "public.orders";
    v.edges = [edge({ from: "public.orders" })];
    const out = toPlantUml(v);
    expect(out).toContain("as public_orders {");
    expect(out).toContain("public_orders }|--|| customers");
  });
});
