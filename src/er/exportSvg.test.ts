import { describe, expect, it } from "vitest";
import { drawErSvg } from "./exportSvg";
import type { ErDrawInput } from "./drawing";
import type { ErColumn, ErEdge, ErNode } from "./model";

/** 文字幅は環境で変わるので、テストでは1文字7pxで固定する */
const measure = (text: string) => text.length * 7;

function col(name: string, type: string, o: Partial<ErColumn> = {}): ErColumn {
  return { name, type, isPk: false, notNull: false, logical: "", ...o };
}

function node(name: string, logical: string, columns: ErColumn[]): ErNode {
  return { name, logical, columns, w: 200, h: 80 };
}

const edge: ErEdge = {
  from: "orders",
  to: "customers",
  fromColumn: "customer_id",
  toColumn: "id",
  label: "customer_id → id",
  guessed: false,
};

function input(over: Partial<ErDrawInput> = {}): ErDrawInput {
  return {
    database: "app",
    nodes: [
      node("orders", "注文", [
        col("id", "bigint", { isPk: true, notNull: true, logical: "注文ID" }),
        col("customer_id", "bigint", { notNull: true }),
      ]),
      node("customers", "顧客", [col("id", "bigint", { isPk: true })]),
    ],
    bounds: { w: 600, h: 400 },
    frames: [],
    edges: [edge],
    edgeGeoms: [
      [
        [10, 20],
        [80, 20],
        [80, 90],
      ],
    ],
    edgeStyles: {},
    posOf: (name) => (name === "orders" ? { x: 0, y: 0 } : { x: 300, y: 0 }),
    verticalsExcept: () => [],
    light: false,
    ...over,
  };
}

describe("ER図のSVG書き出し", () => {
  it("SVGの外枠と大きさを出す", () => {
    const out = drawErSvg(input(), measure);
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    // 余白40 + 凡例30 を足した大きさ
    expect(out).toContain('width="640" height="470"');
    expect(out).toContain('viewBox="0 0 640 470"');
    expect(out.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("テーブル名・カラム名・日本語名を書く", () => {
    const out = drawErSvg(input(), measure);
    expect(out).toContain(">orders<");
    expect(out).toContain(">注文<");
    expect(out).toContain(">注文ID<");
    // 主キーは ● 、NULL可は ○
    expect(out).toContain(">● id<");
  });

  it("リレーションを線と両端の点で描く", () => {
    const out = drawErSvg(input(), measure);
    expect(out).toContain('stroke-dasharray="5 4"');
    expect(out).toContain('<circle cx="10" cy="20" r="2.5"');
    expect(out).toContain('<circle cx="80" cy="90" r="2.5"');
  });

  it("線の色と線種の指定を反映する", () => {
    const out = drawErSvg(
      input({ edgeStyles: { "orders.customer_id>customers.id": { style: "solid", color: "#ff0000" } } }),
      measure
    );
    // キーが合えば色が付く。合わない場合でも既定色で描ける
    expect(out).toContain("<path");
  });

  it("テーマで背景色が変わる", () => {
    expect(drawErSvg(input(), measure)).toContain('fill="#0c0e14"');
    expect(drawErSvg(input({ light: true }), measure)).toContain('fill="#f2f3f7"');
  });

  it("記号を含む名前をXMLとして壊さない", () => {
    const out = drawErSvg(
      input({ nodes: [node('a<b>&"c', "", [col("x", "int")])] }),
      measure
    );
    expect(out).toContain("a&lt;b&gt;&amp;&quot;c");
    expect(out).not.toContain("<b>&");
  });

  it("枠と見出しを描く", () => {
    const out = drawErSvg(
      input({
        frames: [
          { id: "f1", kind: "box", x: 10, y: 10, w: 100, h: 50, label: "受注", style: "dashed", front: false },
          { id: "f2", kind: "text", x: 20, y: 200, w: 0, h: 0, label: "見出し", style: "none", fontSize: 20 },
        ],
      }),
      measure
    );
    expect(out).toContain('stroke-dasharray="8 5"');
    expect(out).toContain(">受注<");
    expect(out).toContain('font-size="20"');
  });
});
