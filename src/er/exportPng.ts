/**
 * ER図をPNGに描き直す処理。
 *
 * 画面 (ErWindow) はDOMで描いているので、保存用にcanvasへ描き直す。
 * 200行近くあり、状態も持たないので、画面の組み立てとは分けておく。
 * ここはReactに依存しない (canvasだけを使う) 純粋な処理
 */
import { edgePath } from "./geometry";

/** 他の線との交差判定に使う縦区間 (geometry.ts の verticalSegments が返す形) */
type VerticalSegment = { x: number; y1: number; y2: number };
import type { ErEdge, ErNode } from "./model";
import { colMarker, edgeKey, NODE_HEAD_H, ROW_H } from "./model";
import { FILL_ALPHA, hexAlpha } from "./style";
import type { ErEdgeStyle, ErFrame } from "../types";

/** PNGを描くのに要るもの (すべて画面が持っている今の状態) */
export interface ErPngInput {
  /** 図の見出しに出すデータベース名 */
  database: string;
  nodes: ErNode[];
  /** 図全体の大きさ */
  bounds: { w: number; h: number };
  frames: ErFrame[];
  edges: ErEdge[];
  /** 各エッジの折れ線 (画面に出ているものと同じ経路) */
  edgeGeoms: ([number, number][] | null)[];
  /** エッジごとの線種・色 */
  edgeStyles: Record<string, ErEdgeStyle>;
  /** テーブルの位置 */
  posOf: (name: string) => { x: number; y: number };
  /** i番目のエッジを描くときに飛び越える、他の線の縦区間 */
  verticalsExcept: (i: number) => VerticalSegment[];
  /** ライトテーマで出力するか */
  light: boolean;
}

/** 現在の配置をcanvasへ描き直し、PNGをbase64で返す */
export function drawErPng(v: ErPngInput): string {
  const {
    database,
    nodes,
    bounds,
    frames,
    edges,
    edgeGeoms,
    edgeStyles,
    posOf,
    verticalsExcept,
    light,
  } = v;
  const pad = 40;
  const legendH = 30;
  const w = bounds.w + pad;
  const h = bounds.h + pad + legendH;
  const scale = Math.min(2, 16000 / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(w * scale);
  canvas.height = Math.ceil(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvasを初期化できません");
  // 呼び出し側で見た表示テーマに合わせる (ライトはライトのまま出力する)
  const pal = light
    ? {
        bg: "#f2f3f7",
        title: "#4f46e5",
        text: "#1f2430",
        dim: "#5b6478",
        faint: "#9aa1b5",
        nodeFill: "#ffffff",
        nodeStroke: "rgba(17, 24, 39, 0.2)",
        headFill: "rgba(99, 102, 241, 0.12)",
        pk: "#4f46e5",
        edge: "rgba(99, 102, 241, 0.85)",
        frame: "rgba(91, 100, 120, 0.55)",
      }
    : {
        bg: "#0c0e14",
        title: "#a5b4fc",
        text: "#e7eaf2",
        dim: "#8b93a8",
        faint: "#5b6275",
        nodeFill: "#141824",
        nodeStroke: "rgba(255, 255, 255, 0.18)",
        headFill: "rgba(99, 102, 241, 0.18)",
        pk: "#a5b4fc",
        edge: "rgba(99, 102, 241, 0.8)",
        frame: "rgba(139, 147, 168, 0.55)",
      };
  ctx.scale(scale, scale);
  ctx.textBaseline = "middle";
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, w, h);

  // 凡例
  ctx.font = 'bold 14px -apple-system, "Hiragino Sans", sans-serif';
  ctx.fillStyle = pal.title;
  ctx.fillText(`Quelio ER図 — ${database}`, 20, 18);
  ctx.font = '11px "SF Mono", Menlo, Consolas, monospace';
  ctx.fillStyle = pal.dim;
  ctx.fillText(
    "破線 = リレーション ・ ● = NOT NULL / ○ = NULL可 (色付き● = 主キー)",
    300,
    18
  );

  const oy = legendH;
  /** 注釈枠 (box) を1個描く */
  const drawBox = (f: ErFrame) => {
    const r = f.rounded === false ? 3 : 10;
    if (f.fill) {
      ctx.fillStyle = hexAlpha(f.fill, FILL_ALPHA);
      ctx.beginPath();
      ctx.roundRect(f.x + 20, f.y + oy, f.w, f.h, r);
      ctx.fill();
    }
    if (f.style !== "none") {
      ctx.strokeStyle = f.color ? hexAlpha(f.color, 0.75) : pal.frame;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(
        f.style === "dashed" ? [8, 5] : f.style === "dotted" ? [2, 4] : []
      );
      ctx.beginPath();
      ctx.roundRect(f.x + 20, f.y + oy, f.w, f.h, r);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.font = '12px -apple-system, "Hiragino Sans", sans-serif';
    ctx.fillStyle = pal.dim;
    ctx.fillText(f.label, f.x + 20 + 10, f.y + oy + 14);
  };
  /** テキスト見出しを1個描く */
  const drawText = (f: ErFrame) => {
    const size = f.fontSize ?? 18;
    ctx.font = `bold ${size}px -apple-system, "Hiragino Sans", sans-serif`;
    ctx.fillStyle = f.textColor || pal.dim;
    ctx.fillText(f.label, f.x + 20 + 4, f.y + oy + size * 0.75 + 2);
  };
  // 注釈枠 (背面)
  for (const f of frames) {
    if (f.kind !== "text" && !f.front) drawBox(f);
  }
  // エッジ (カラム行から出る鍵線。交差は半円で飛び越える)
  ctx.save();
  ctx.translate(20, oy);
  for (let i = 0; i < edges.length; i++) {
    const pts = edgeGeoms[i];
    if (!pts) continue;
    const es = edgeStyles[edgeKey(edges[i])];
    const strokeColor = es?.color ?? pal.edge;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.2;
    ctx.setLineDash(
      es?.style === "solid" ? [] : es?.style === "dotted" ? [2, 4] : [5, 4]
    );
    ctx.stroke(new Path2D(edgePath(pts, verticalsExcept(i))));
    // 両端の接続点
    ctx.setLineDash([]);
    ctx.fillStyle = strokeColor;
    for (const [px2, py2] of [pts[0], pts[pts.length - 1]]) {
      ctx.beginPath();
      ctx.arc(px2, py2, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  ctx.setLineDash([]);
  // ノード
  for (const n of nodes) {
    const p = posOf(n.name);
    const x = p.x + 20;
    const y = p.y + oy;
    ctx.fillStyle = pal.nodeFill;
    ctx.strokeStyle = pal.nodeStroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, n.w, n.h, 8);
    ctx.fill();
    ctx.stroke();
    // ヘッダ
    ctx.fillStyle = pal.headFill;
    ctx.beginPath();
    ctx.roundRect(x, y, n.w, NODE_HEAD_H, [8, 8, 0, 0]);
    ctx.fill();
    ctx.font = 'bold 12px "SF Mono", Menlo, Consolas, monospace';
    ctx.fillStyle = pal.text;
    ctx.fillText(n.name, x + 9, y + NODE_HEAD_H / 2);
    if (n.logical) {
      const nameW = ctx.measureText(n.name).width;
      ctx.font = '10.5px -apple-system, "Hiragino Sans", sans-serif';
      ctx.fillStyle = pal.dim;
      ctx.fillText(n.logical, x + 9 + nameW + 8, y + NODE_HEAD_H / 2);
    }
    // カラム (名前 / 型 / 日本語名を画面表示と同じく縦列を揃えて描画)
    ctx.font = '11px "SF Mono", Menlo, Consolas, monospace';
    const nameColW = Math.max(
      0,
      ...n.columns.map((c) => ctx.measureText(colMarker(c) + c.name).width)
    );
    const typeColW = Math.max(
      0,
      ...n.columns.map((c) => ctx.measureText(c.type).width)
    );
    n.columns.forEach((c, i) => {
      const cy = y + NODE_HEAD_H + i * ROW_H + ROW_H / 2;
      const nameText = colMarker(c) + c.name;
      ctx.fillStyle = c.isPk ? pal.pk : pal.dim;
      ctx.fillText(nameText, x + 9, cy);
      if (c.type) {
        ctx.fillStyle = pal.faint;
        ctx.fillText(c.type, x + 9 + nameColW + 10, cy);
      }
      if (c.logical) {
        ctx.fillStyle = pal.dim;
        ctx.fillText(
          c.logical,
          x + 9 + nameColW + (typeColW > 0 ? typeColW + 10 : 0) + 10,
          cy
        );
      }
    });
  }
  // 注釈枠 (前面) とテキスト見出し (最前面)
  for (const f of frames) {
    if (f.kind !== "text" && f.front) drawBox(f);
  }
  for (const f of frames) {
    if (f.kind === "text") drawText(f);
  }

  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}
