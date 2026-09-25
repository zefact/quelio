/**
 * ER図をExcelの図形として書き出すための中身を組み立てる。
 *
 * 配置・色・文字の並びはSVG/PNGと同じ。ここでは
 * 「どの図形に線の端をくっつけるか」まで決めて、描くのはRust側に任せる。
 * Excelの紙は白いので、テーマに関わらずライトの配色で出す
 */
import { edgeKey, colMarker, NODE_HEAD_H, ROW_H } from "./model";
import type { ErColumn, ErNode } from "./model";
import { FILL_ALPHA } from "./style";
import {
  erPalette,
  FONT_MONO,
  FONT_UI,
  LEGEND_H,
  LEGEND_NOTE,
  OX,
  type ErDrawInput,
} from "./drawing";
import type { MeasureText } from "./exportSvg";
import type { ErEdgeStyle, ErFrame } from "../types";
import {
  toPaint,
  toRgb,
  type XlsxCell,
  type XlsxDash,
  type XlsxErSheet,
  type XlsxGlue,
  type XlsxTable,
} from "./xlsxModel";

/** 文字の左余白 (SVGと同じ) */
const PAD_X = 9;
/** 端がテーブルの辺・行の中心に乗っているとみなす誤差 */
const EPS = 0.5;

function edgeDash(style: ErEdgeStyle["style"] | undefined): XlsxDash {
  if (style === "solid") return "solid";
  if (style === "dotted") return "dot";
  return "dash";
}

function frameDash(style: ErFrame["style"]): XlsxDash {
  if (style === "dashed") return "dash";
  if (style === "dotted") return "dot";
  return "solid";
}

/**
 * 線の端 (図の座標) がテーブルのどこに乗っているか。
 * 左右の辺ならカラム行 (無ければ見出し) に、上下の辺なら外枠につなぐ
 */
export function glueAt(
  index: number,
  n: ErNode,
  p: { x: number; y: number },
  [px, py]: [number, number]
): XlsxGlue | null {
  const near = (a: number, b: number) => Math.abs(a - b) <= EPS;
  const inX = px >= p.x - EPS && px <= p.x + n.w + EPS;
  const inY = py >= p.y - EPS && py <= p.y + n.h + EPS;
  if ((near(px, p.x) || near(px, p.x + n.w)) && inY) {
    const side = near(px, p.x) ? "left" : "right";
    const row = n.columns.findIndex((_, i) =>
      near(py, p.y + NODE_HEAD_H + i * ROW_H + ROW_H / 2)
    );
    if (row >= 0) return { table: index, target: { kind: "row", index: row }, side };
    if (near(py, p.y + NODE_HEAD_H / 2)) {
      return { table: index, target: { kind: "head" }, side };
    }
    return { table: index, target: { kind: "body" }, side };
  }
  if ((near(py, p.y) || near(py, p.y + n.h)) && inX) {
    const side = near(py, p.y) ? "top" : "bottom";
    return { table: index, target: { kind: "body" }, side };
  }
  return null;
}

/** テーブル1つ (カラム行は 名前 / 型 / 日本語名 をタブで揃える) */
function tableOf(
  nd: ErNode,
  p: { x: number; y: number },
  oy: number,
  measure: MeasureText,
  pal: ReturnType<typeof erPalette>
): XlsxTable {
  const colFont = `11px ${FONT_MONO}`;
  const nameColW = Math.max(
    0,
    ...nd.columns.map((c: ErColumn) => measure(colMarker(c) + c.name, colFont))
  );
  const typeColW = Math.max(0, ...nd.columns.map((c) => measure(c.type, colFont)));
  const hasType = typeColW > 0;
  const hasLogical = nd.columns.some((c) => c.logical);
  const tabs: number[] = [];
  if (hasType) tabs.push(nameColW + 10);
  if (hasLogical) tabs.push(nameColW + (hasType ? typeColW + 10 : 0) + 10);
  const rows = nd.columns.map((c) => {
    const cells: XlsxCell[] = [
      {
        text: colMarker(c) + c.name,
        color: toRgb(c.color ?? (c.isPk ? pal.pk : pal.dim)),
        mono: true,
      },
    ];
    if (hasType) cells.push({ text: c.type, color: toRgb(pal.faint), mono: true });
    if (hasLogical) cells.push({ text: c.logical, color: toRgb(pal.dim), mono: false });
    // 後ろの空欄は区切りごと省く
    while (cells.length > 1 && !cells[cells.length - 1].text) cells.pop();
    return cells;
  });
  return {
    name: nd.name,
    logical: nd.logical,
    x: p.x + OX,
    y: p.y + oy,
    w: nd.w,
    h: nd.h,
    tabs,
    rows,
  };
}

/** 現在の配置を、Excelへ書き出す図の中身にする */
export function buildErSheet(v: ErDrawInput, measure: MeasureText): XlsxErSheet {
  const { database, nodes, frames, edges, edgeGeoms, edgeStyles, posOf } = v;
  const pal = erPalette(true);
  const oy = LEGEND_H;
  const index = new Map(nodes.map((n, i) => [n.name, i]));

  const tables = nodes.map((nd) => tableOf(nd, posOf(nd.name), oy, measure, pal));

  const outEdges: XlsxErSheet["edges"] = [];
  edges.forEach((e, i) => {
    const pts = edgeGeoms[i];
    if (!pts || pts.length < 2) return;
    const es = edgeStyles[edgeKey(e)];
    const glue = (name: string, pt: [number, number]) => {
      const k = index.get(name);
      return k === undefined ? null : glueAt(k, nodes[k], posOf(name), pt);
    };
    outEdges.push({
      name: `${e.from}.${e.fromColumn} → ${e.to}.${e.toColumn}`,
      points: pts.map(([x, y]) => [x + OX, y + oy]),
      color: toPaint(es?.color ?? pal.edge),
      dash: edgeDash(es?.style),
      from: glue(e.from, pts[0]),
      to: glue(e.to, pts[pts.length - 1]),
    });
  });

  const boxes = frames.filter((f) => f.kind !== "text");
  const texts = frames.filter((f) => f.kind === "text");

  const title = `Quelio ER図 — ${database}`;
  const labels: XlsxErSheet["labels"] = [
    {
      text: title,
      x: OX,
      y: 6,
      w: measure(title, `bold 14px ${FONT_UI}`) + 8,
      h: 24,
      size: 14,
      color: toRgb(pal.title),
      bold: true,
      mono: false,
    },
    {
      text: LEGEND_NOTE,
      x: 300,
      y: 8,
      w: measure(LEGEND_NOTE, `11px ${FONT_MONO}`) + 8,
      h: 20,
      size: 11,
      color: toRgb(pal.dim),
      bold: false,
      mono: true,
    },
    ...texts.map((f) => {
      const size = f.fontSize ?? 18;
      return {
        text: f.label,
        x: f.x + OX + 4,
        y: f.y + oy + 2,
        w: Math.max(f.w - 4, measure(f.label, `bold ${size}px ${FONT_UI}`) + 8),
        h: size * 1.5,
        size,
        color: toRgb(f.textColor || pal.dim),
        bold: true,
        mono: false,
      };
    }),
  ];

  return {
    name: database,
    palette: {
      text: toRgb(pal.text),
      dim: toRgb(pal.dim),
      nodeFill: toPaint(pal.nodeFill),
      nodeStroke: toPaint(pal.nodeStroke),
      headFill: toPaint(pal.headFill),
    },
    headH: NODE_HEAD_H,
    rowH: ROW_H,
    padX: PAD_X,
    tables,
    frames: boxes.map((f) => ({
      label: f.label,
      x: f.x + OX,
      y: f.y + oy,
      w: f.w,
      h: f.h,
      rounded: f.rounded !== false,
      stroke:
        f.style === "none" ? null : f.color ? toPaint(f.color, 0.75) : toPaint(pal.frame),
      dash: frameDash(f.style),
      fill: f.fill ? toPaint(f.fill, FILL_ALPHA) : null,
      labelColor: toRgb(pal.dim),
      front: !!f.front,
    })),
    edges: outEdges,
    labels,
  };
}
