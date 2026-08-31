/**
 * ER図をSVGに描き直す処理。
 *
 * PNGと同じ配置・同じ色で、拡大しても崩れない形で出す。
 * 図をそのままドキュメントや資料に貼れるようにするのが目的。
 * ここはReactにもDOMにも依存しない (文字幅の測り方だけ差し替えられる)
 */
import { edgePath } from "./geometry";
import { colMarker, edgeKey, NODE_HEAD_H, ROW_H } from "./model";
import type { ErColumn } from "./model";
import { FILL_ALPHA, hexAlpha } from "./style";
import {
  dashOf,
  erPalette,
  FONT_MONO,
  FONT_UI,
  frameDashOf,
  LEGEND_H,
  LEGEND_NOTE,
  OX,
  PAD,
  type ErDrawInput,
} from "./drawing";

/** 文字幅の測り方 (既定はcanvas。テストでは差し替える) */
export type MeasureText = (text: string, font: string) => number;

/** canvasで文字幅を測る (画面で使う既定の実装) */
function canvasMeasure(): MeasureText {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) throw new Error("canvasを初期化できません");
  return (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

/** XMLに入れられない文字を実体参照にする */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 小数を短く丸める (ファイルサイズ対策) */
function n(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * canvas の textBaseline="middle" と同じ見え方にするためのベースライン。
 *
 * dominant-baseline はビューアによって解釈が違うので、
 * 文字サイズから概算した位置を y に入れて互換性を上げる
 */
function midY(cy: number, size: number): number {
  return cy + size * 0.35;
}

/** 角丸の矩形パス (上だけ丸めるといった指定もできる) */
function roundRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number | [number, number, number, number]
): string {
  const [tl, tr, br, bl] = typeof r === "number" ? [r, r, r, r] : r;
  return [
    `M ${n(x + tl)} ${n(y)}`,
    `H ${n(x + w - tr)}`,
    tr ? `A ${n(tr)} ${n(tr)} 0 0 1 ${n(x + w)} ${n(y + tr)}` : "",
    `V ${n(y + h - br)}`,
    br ? `A ${n(br)} ${n(br)} 0 0 1 ${n(x + w - br)} ${n(y + h)}` : "",
    `H ${n(x + bl)}`,
    bl ? `A ${n(bl)} ${n(bl)} 0 0 1 ${n(x)} ${n(y + h - bl)}` : "",
    `V ${n(y + tl)}`,
    tl ? `A ${n(tl)} ${n(tl)} 0 0 1 ${n(x + tl)} ${n(y)}` : "",
    "Z",
  ]
    .filter(Boolean)
    .join(" ");
}

/** <text> を1つ作る */
function text(
  x: number,
  y: number,
  size: number,
  font: string,
  fill: string,
  body: string,
  bold = false
): string {
  const w = bold ? ' font-weight="700"' : "";
  return `<text x="${n(x)}" y="${n(y)}" font-family="${esc(font)}" font-size="${size}"${w} fill="${fill}">${esc(body)}</text>`;
}

/** 現在の配置をSVGの文字列にする */
export function drawErSvg(v: ErDrawInput, measure?: MeasureText): string {
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
  const m = measure ?? canvasMeasure();
  const pal = erPalette(light);
  const w = bounds.w + PAD;
  const h = bounds.h + PAD + LEGEND_H;
  const oy = LEGEND_H;
  const out: string[] = [];

  out.push(`<rect width="${n(w)}" height="${n(h)}" fill="${pal.bg}"/>`);

  // 凡例
  out.push(
    text(OX, midY(18, 14), 14, FONT_UI, pal.title, `Quelio ER図 — ${database}`, true)
  );
  out.push(text(300, midY(18, 11), 11, FONT_MONO, pal.dim, LEGEND_NOTE));

  /** 注釈枠 (box) を1個 */
  const drawBox = (f: (typeof frames)[number]) => {
    const r = f.rounded === false ? 3 : 10;
    const d = roundRect(f.x + OX, f.y + oy, f.w, f.h, r);
    if (f.fill) {
      out.push(`<path d="${d}" fill="${hexAlpha(f.fill, FILL_ALPHA)}"/>`);
    }
    if (f.style !== "none") {
      const dash = frameDashOf(f.style);
      out.push(
        `<path d="${d}" fill="none" stroke="${f.color ? hexAlpha(f.color, 0.75) : pal.frame}" stroke-width="1.5"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`
      );
    }
    out.push(
      text(f.x + OX + 10, midY(f.y + oy + 14, 12), 12, FONT_UI, pal.dim, f.label)
    );
  };
  /** テキスト見出しを1個 */
  const drawText = (f: (typeof frames)[number]) => {
    const size = f.fontSize ?? 18;
    out.push(
      text(
        f.x + OX + 4,
        midY(f.y + oy + size * 0.75 + 2, size),
        size,
        FONT_UI,
        f.textColor || pal.dim,
        f.label,
        true
      )
    );
  };

  // 注釈枠 (背面)
  for (const f of frames) if (f.kind !== "text" && !f.front) drawBox(f);

  // エッジ (カラム行から出る鍵線。交差は半円で飛び越える)
  out.push(`<g transform="translate(${OX} ${oy})">`);
  for (let i = 0; i < edges.length; i++) {
    const pts = edgeGeoms[i];
    if (!pts) continue;
    const es = edgeStyles[edgeKey(edges[i])];
    const color = es?.color ?? pal.edge;
    const dash = dashOf(es?.style);
    out.push(
      `<path d="${edgePath(pts, verticalsExcept(i))}" fill="none" stroke="${color}" stroke-width="1.2"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`
    );
    // 両端の接続点
    for (const [px, py] of [pts[0], pts[pts.length - 1]]) {
      out.push(`<circle cx="${n(px)}" cy="${n(py)}" r="2.5" fill="${color}"/>`);
    }
  }
  out.push("</g>");

  // ノード
  const headFont = `bold 12px ${FONT_MONO}`;
  const colFont = `11px ${FONT_MONO}`;
  for (const nd of nodes) {
    const p = posOf(nd.name);
    const x = p.x + OX;
    const y = p.y + oy;
    out.push(
      `<path d="${roundRect(x, y, nd.w, nd.h, 8)}" fill="${pal.nodeFill}" stroke="${pal.nodeStroke}" stroke-width="1"/>`
    );
    // ヘッダ (上だけ角丸)
    out.push(
      `<path d="${roundRect(x, y, nd.w, NODE_HEAD_H, [8, 8, 0, 0])}" fill="${pal.headFill}"/>`
    );
    const cy = y + NODE_HEAD_H / 2;
    out.push(text(x + 9, midY(cy, 12), 12, FONT_MONO, pal.text, nd.name, true));
    if (nd.logical) {
      const nameW = m(nd.name, headFont);
      out.push(
        text(x + 9 + nameW + 8, midY(cy, 10.5), 10.5, FONT_UI, pal.dim, nd.logical)
      );
    }
    // カラム (名前 / 型 / 日本語名を画面表示と同じく縦列を揃える)
    const nameColW = Math.max(
      0,
      ...nd.columns.map((c: ErColumn) => m(colMarker(c) + c.name, colFont))
    );
    const typeColW = Math.max(
      0,
      ...nd.columns.map((c: ErColumn) => m(c.type, colFont))
    );
    nd.columns.forEach((c: ErColumn, i: number) => {
      const ry = y + NODE_HEAD_H + i * ROW_H + ROW_H / 2;
      out.push(
        text(
          x + 9,
          midY(ry, 11),
          11,
          FONT_MONO,
          c.isPk ? pal.pk : pal.dim,
          colMarker(c) + c.name
        )
      );
      if (c.type) {
        out.push(
          text(x + 9 + nameColW + 10, midY(ry, 11), 11, FONT_MONO, pal.faint, c.type)
        );
      }
      if (c.logical) {
        out.push(
          text(
            x + 9 + nameColW + (typeColW > 0 ? typeColW + 10 : 0) + 10,
            midY(ry, 11),
            11,
            FONT_UI,
            pal.dim,
            c.logical
          )
        );
      }
    });
  }

  // 注釈枠 (前面) とテキスト見出し (最前面)
  for (const f of frames) if (f.kind !== "text" && f.front) drawBox(f);
  for (const f of frames) if (f.kind === "text") drawText(f);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" viewBox="0 0 ${n(w)} ${n(h)}">`,
    ...out,
    "</svg>",
    "",
  ].join("\n");
}
