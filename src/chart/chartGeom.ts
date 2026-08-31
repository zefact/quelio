/**
 * グラフの座標計算。
 *
 * 画面 (SVG) とPNG保存 (canvas) で同じ絵になるよう、
 * 位置と大きさの計算だけをここに置く。色や描き方は呼び出し側が持つ
 */
import type { ChartData, ChartPoint } from "./chartData";

/** 棒の太さの上限 (太いと画面が騒がしくなる) */
export const MAX_BAR_W = 24;
/** 触れる目印の半径 (これ以上小さくしない) */
export const DOT_R = 4;
/** 隣り合う面のあいだに空ける地色の隙間 */
export const GAP = 2;

export interface ChartBox {
  w: number;
  h: number;
  /** 目盛の文字ぶんの余白 */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 描画に使う内側の領域 */
export function plotArea(box: ChartBox) {
  return {
    x: box.left,
    y: box.top,
    w: Math.max(1, box.w - box.left - box.right),
    h: Math.max(1, box.h - box.top - box.bottom),
  };
}

/** 値 → 縦位置 */
export function yScale(data: ChartData, box: ChartBox) {
  const plot = plotArea(box);
  const lo = data.ticks.length ? data.ticks[0] : 0;
  const hi = data.ticks.length ? data.ticks[data.ticks.length - 1] : 1;
  const span = hi - lo || 1;
  return (v: number) => plot.y + plot.h - ((v - lo) / span) * plot.h;
}

export interface BarGeom {
  point: ChartPoint;
  index: number;
  x: number;
  w: number;
  /** 棒の上端 (負の値なら基準線から下に伸びる) */
  y: number;
  h: number;
  /** 触れる範囲 (棒より広く取る) */
  bandX: number;
  bandW: number;
}

/** 棒グラフの棒の位置 */
export function barGeoms(data: ChartData, box: ChartBox): BarGeom[] {
  const plot = plotArea(box);
  const toY = yScale(data, box);
  const zero = toY(0);
  const band = plot.w / Math.max(1, data.points.length);
  const w = Math.max(1, Math.min(MAX_BAR_W, band - GAP * 2));
  return data.points.map((point, index) => {
    const bandX = plot.x + band * index;
    const x = bandX + (band - w) / 2;
    const v = toY(point.value);
    return {
      point,
      index,
      x,
      w,
      y: Math.min(v, zero),
      h: Math.max(1, Math.abs(v - zero)),
      bandX,
      bandW: band,
    };
  });
}

export interface LinePoint {
  point: ChartPoint;
  index: number;
  x: number;
  y: number;
  bandX: number;
  bandW: number;
}

/** 折れ線の点の位置 */
export function lineGeoms(data: ChartData, box: ChartBox): LinePoint[] {
  const plot = plotArea(box);
  const toY = yScale(data, box);
  const n = data.points.length;
  const band = plot.w / Math.max(1, n);
  return data.points.map((point, index) => ({
    point,
    index,
    // 点が1つだけのときは真ん中に置く
    x: n === 1 ? plot.x + plot.w / 2 : plot.x + band * index + band / 2,
    y: toY(point.value),
    bandX: plot.x + band * index,
    bandW: band,
  }));
}

export interface SliceGeom {
  point: ChartPoint;
  index: number;
  /** 開始角と終了角 (ラジアン。真上から時計回り) */
  from: number;
  to: number;
  ratio: number;
}

/** 円グラフの扇の角度 */
export function sliceGeoms(data: ChartData): SliceGeom[] {
  const sum = data.points.reduce((s, p) => s + p.value, 0) || 1;
  let at = -Math.PI / 2;
  return data.points.map((point, index) => {
    const ratio = point.value / sum;
    const from = at;
    at += ratio * Math.PI * 2;
    return { point, index, from, to: at, ratio };
  });
}

/** 扇のパス (中心 cx,cy 半径 r) */
export function slicePath(
  s: SliceGeom,
  cx: number,
  cy: number,
  r: number
): string {
  // まるごと1件のときは円をそのまま描く (弧では閉じられない)
  if (s.ratio >= 0.999) {
    return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`;
  }
  const x1 = cx + r * Math.cos(s.from);
  const y1 = cy + r * Math.sin(s.from);
  const x2 = cx + r * Math.cos(s.to);
  const y2 = cy + r * Math.sin(s.to);
  const large = s.to - s.from > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

/** 上だけ角を丸めた棒のパス (下端は基準線に合わせて角のまま) */
export function barPath(b: BarGeom, radius = 4): string {
  const r = Math.min(radius, b.w / 2, b.h);
  const { x, y, w, h } = b;
  return [
    `M ${x} ${y + h}`,
    `V ${y + r}`,
    `A ${r} ${r} 0 0 1 ${x + r} ${y}`,
    `H ${x + w - r}`,
    `A ${r} ${r} 0 0 1 ${x + w} ${y + r}`,
    `V ${y + h}`,
    "Z",
  ].join(" ");
}

/** 目盛や凡例に出す数字 (桁区切り) */
export function fmtValue(v: number): string {
  return Number.isInteger(v) ? v.toLocaleString() : String(v);
}
