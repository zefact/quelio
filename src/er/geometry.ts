/**
 * ER図の線の座標計算。
 * テーブルを避ける経路探索や、交差の飛び越えなど。
 * 画面に依存しない純関数だけを置く
 */

import type { ErAnchorPoint } from "../types";
import { ErNode, NODE_HEAD_H, ROW_H } from "./model";

/** カラム行の中心Y座標 (表示中でなければヘッダ中心) */
export function anchorY(n: ErNode, topY: number, col: string): number {
  const i = n.columns.findIndex((c) => c.name === col);
  return i >= 0
    ? topY + NODE_HEAD_H + i * ROW_H + ROW_H / 2
    : topY + NODE_HEAD_H / 2;
}

/** 鍵線 (直角折れ線) の経路を計算する。座標はノード左上+アンカーYで渡す */
export function edgePoints(
  a: { x: number; w: number },
  ay: number,
  b: { x: number; w: number },
  by: number
): [number, number][] {
  const MIN_GAP = 28;
  const aL = a.x;
  const aR = a.x + a.w;
  const bL = b.x;
  const bR = b.x + b.w;
  // 参照元が左・参照先が右
  if (aR + MIN_GAP <= bL) {
    const midX = (aR + bL) / 2;
    return [
      [aR, ay],
      [midX, ay],
      [midX, by],
      [bL, by],
    ];
  }
  // 参照元が右・参照先が左
  if (bR + MIN_GAP <= aL) {
    const midX = (bR + aL) / 2;
    return [
      [aL, ay],
      [midX, ay],
      [midX, by],
      [bR, by],
    ];
  }
  // 横方向に重なっている場合は右側を回り込む
  const outerX = Math.max(aR, bR) + 34;
  return [
    [aR, ay],
    [outerX, ay],
    [outerX, by],
    [bR, by],
  ];
}

/** 線の交差を飛び越える半円の半径 */
export const HOP_R = 6;

/** 折れ線から垂直区間を抜き出す */
export function verticalSegments(
  pts: [number, number][]
): { x: number; y1: number; y2: number }[] {
  const segs: { x: number; y1: number; y2: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (x0 === x1 && y0 !== y1) segs.push({ x: x0, y1: y0, y2: y1 });
  }
  return segs;
}

/** 折れ線をSVGパスにする。水平区間が他の線の垂直区間と交差する位置には
 * 半円 (飛び越え) を入れる。近接する交差はまとめて1つの山にする */
export function edgePath(
  pts: [number, number][],
  verticals: { x: number; y1: number; y2: number }[]
): string {
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (y0 === y1 && x0 !== x1) {
      const minX = Math.min(x0, x1);
      const maxX = Math.max(x0, x1);
      const dir = x1 > x0 ? 1 : -1;
      // この水平区間と交差する垂直線のX座標 (端に近すぎるものは除く)
      const xs = verticals
        .filter(
          (v) =>
            v.x > minX + HOP_R &&
            v.x < maxX - HOP_R &&
            y0 > Math.min(v.y1, v.y2) + 1 &&
            y0 < Math.max(v.y1, v.y2) - 1
        )
        .map((v) => v.x)
        .sort((a, b) => (a - b) * dir);
      // 近接する交差をグループ化して1つの山で飛び越える
      const groups: [number, number][] = [];
      for (const cx of xs) {
        const g = groups[groups.length - 1];
        if (g && Math.abs(cx - g[1]) < HOP_R * 2.5) g[1] = cx;
        else groups.push([cx, cx]);
      }
      for (const [gs, ge] of groups) {
        const a = gs - HOP_R * dir;
        const b = ge + HOP_R * dir;
        const rx = Math.abs(b - a) / 2;
        d += ` L ${a} ${y0} A ${rx} ${HOP_R} 0 0 ${dir > 0 ? 1 : 0} ${b} ${y0}`;
      }
      d += ` L ${x1} ${y1}`;
    } else {
      d += ` L ${x1} ${y1}`;
    }
  }
  return d;
}

/** 接続点付きの座標 (どの辺から出るかを持つ) */
export interface AnchoredPt {
  x: number;
  y: number;
  side: ErAnchorPoint["side"];
}

/** アンカー指定 (辺+割合) をテーブル境界上の座標にする */
export function anchorPointPos(
  n: ErNode,
  p: { x: number; y: number },
  a: ErAnchorPoint
): AnchoredPt {
  switch (a.side) {
    case "top":
      return { x: p.x + a.t * n.w, y: p.y, side: "top" };
    case "bottom":
      return { x: p.x + a.t * n.w, y: p.y + n.h, side: "bottom" };
    case "left":
      return { x: p.x, y: p.y + a.t * n.h, side: "left" };
    default:
      return { x: p.x + n.w, y: p.y + a.t * n.h, side: "right" };
  }
}

/** カラム行から出る既定の接続点 (相手のX位置に近い側の辺を選ぶ) */
export function colSideAnchor(
  n: ErNode,
  p: { x: number; y: number },
  col: string,
  refX: number
): AnchoredPt {
  const y = anchorY(n, p.y, col);
  return refX >= p.x + n.w / 2
    ? { x: p.x + n.w, y, side: "right" }
    : { x: p.x, y, side: "left" };
}

/** カーソル位置に最も近いテーブル境界上のアンカーを求める。
 * 左右の辺ではカラム行の中心に吸着する */
export function nearestBorderAnchor(
  n: ErNode,
  p: { x: number; y: number },
  wx: number,
  wy: number
): ErAnchorPoint {
  const cx = Math.min(Math.max(wx, p.x), p.x + n.w);
  const cy = Math.min(Math.max(wy, p.y), p.y + n.h);
  const dL = Math.abs(wx - p.x);
  const dR = Math.abs(wx - (p.x + n.w));
  const dT = Math.abs(wy - p.y);
  const dB = Math.abs(wy - (p.y + n.h));
  const m = Math.min(dL, dR, dT, dB);
  let side: ErAnchorPoint["side"];
  let t: number;
  if (m === dT) {
    side = "top";
    t = (cx - p.x) / n.w;
  } else if (m === dB) {
    side = "bottom";
    t = (cx - p.x) / n.w;
  } else if (m === dL) {
    side = "left";
    t = (cy - p.y) / n.h;
  } else {
    side = "right";
    t = (cy - p.y) / n.h;
  }
  // 左右の辺ではカラム行の中心に吸着する
  if (side === "left" || side === "right") {
    const y = p.y + t * n.h;
    for (let i = 0; i < n.columns.length; i++) {
      const ry = p.y + NODE_HEAD_H + i * ROW_H + ROW_H / 2;
      if (Math.abs(y - ry) < 7) {
        t = (ry - p.y) / n.h;
        break;
      }
    }
  }
  return { side, t: Math.min(1, Math.max(0, t)) };
}

/** アンカーから外へ出る垂線の長さ */
export const STUB = 24;

/** 辺の外向き単位ベクトル */
export function sideDir(s: ErAnchorPoint["side"]): [number, number] {
  return s === "left"
    ? [-1, 0]
    : s === "right"
      ? [1, 0]
      : s === "top"
        ? [0, -1]
        : [0, 1];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 直交線分が矩形の内部を通るか (境界上をなぞるだけなら通らない扱い) */
export function segHitsRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: Rect
): boolean {
  if (x0 === x1) {
    if (x0 <= r.x || x0 >= r.x + r.w) return false;
    const lo = Math.min(y0, y1);
    const hi = Math.max(y0, y1);
    return hi > r.y && lo < r.y + r.h;
  }
  if (y0 === y1) {
    if (y0 <= r.y || y0 >= r.y + r.h) return false;
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    return hi > r.x && lo < r.x + r.w;
  }
  return false;
}

/** 経路がどの矩形の内部も通らないか */
export function pathClear(pts: [number, number][], rects: Rect[]): boolean {
  for (let i = 1; i < pts.length; i++) {
    for (const r of rects) {
      if (segHitsRect(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], r)) {
        return false;
      }
    }
  }
  return true;
}

/** 連続する同一点と一直線上の中間点を取り除く */
export function simplifyPath(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (l && l[0] === p[0] && l[1] === p[1]) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const [ax, ay] = out[i - 1];
    const [bx, by] = out[i];
    const [cx, cy] = out[i + 1];
    if ((ax === bx && bx === cx) || (ay === by && by === cy)) {
      out.splice(i, 1);
    }
  }
  return out;
}

/** アンカー指定の線の単純な鍵線経路 (障害物は考慮しない) */
export function routeAnchored(a: AnchoredPt, b: AnchoredPt): [number, number][] {
  const [adx, ady] = sideDir(a.side);
  const [bdx, bdy] = sideDir(b.side);
  const s1: [number, number] = [a.x + adx * STUB, a.y + ady * STUB];
  const s2: [number, number] = [b.x + bdx * STUB, b.y + bdy * STUB];
  const pts: [number, number][] = [[a.x, a.y], s1];
  const aH = adx !== 0;
  const bH = bdx !== 0;
  if (aH && bH) {
    const midX = (s1[0] + s2[0]) / 2;
    pts.push([midX, s1[1]], [midX, s2[1]]);
  } else if (!aH && !bH) {
    const midY = (s1[1] + s2[1]) / 2;
    pts.push([s1[0], midY], [s2[0], midY]);
  } else if (aH) {
    pts.push([s2[0], s1[1]]);
  } else {
    pts.push([s1[0], s2[1]]);
  }
  pts.push(s2, [b.x, b.y]);
  return simplifyPath(pts);
}

/** 両端のテーブル矩形を避けて直交経路を探す (小さな格子上のダイクストラ)。
 * 線がテーブルの後ろに隠れないようにするための迂回ルート。
 * 見つからなければnull (呼び出し側で単純経路にフォールバック) */
export function routeAvoid(
  a: AnchoredPt,
  b: AnchoredPt,
  rects: Rect[]
): [number, number][] | null {
  const M = 14; // テーブルから離す余白
  const BEND = 60; // 折れ曲がりのコスト (少ない曲がりを優先)
  const [adx, ady] = sideDir(a.side);
  const [bdx, bdy] = sideDir(b.side);
  const s1x = a.x + adx * STUB;
  const s1y = a.y + ady * STUB;
  const s2x = b.x + bdx * STUB;
  const s2y = b.y + bdy * STUB;
  const infl = rects.map((r) => ({
    x: r.x - M,
    y: r.y - M,
    w: r.w + M * 2,
    h: r.h + M * 2,
  }));
  const xs = [
    ...new Set([s1x, s2x, ...infl.flatMap((r) => [r.x, r.x + r.w])]),
  ].sort((p, q) => p - q);
  const ys = [
    ...new Set([s1y, s2y, ...infl.flatMap((r) => [r.y, r.y + r.h])]),
  ].sort((p, q) => p - q);
  const nx = xs.length;
  const ny = ys.length;
  const x1i = xs.indexOf(s1x);
  const y1i = ys.indexOf(s1y);
  const x2i = xs.indexOf(s2x);
  const y2i = ys.indexOf(s2y);
  const DIRS: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const sid = (xi: number, yi: number, d: number) => (yi * nx + xi) * 4 + d;
  const N = nx * ny * 4;
  const dist = new Array<number>(N).fill(Infinity);
  const prev = new Array<number>(N).fill(-1);
  const visited = new Array<boolean>(N).fill(false);
  const startDir = DIRS.findIndex(([dx, dy]) => dx === adx && dy === ady);
  dist[sid(x1i, y1i, startDir)] = 0;
  // ノード数が高々数百なので線形探索のダイクストラで十分
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < N; i++) {
      if (!visited[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u < 0) break;
    visited[u] = true;
    const d = u % 4;
    const cell = (u - d) / 4;
    const xi = cell % nx;
    const yi = (cell - xi) / nx;
    for (let nd = 0; nd < 4; nd++) {
      const [dx, dy] = DIRS[nd];
      const xj = xi + dx;
      const yj = yi + dy;
      if (xj < 0 || xj >= nx || yj < 0 || yj >= ny) continue;
      let blocked = false;
      for (const r of infl) {
        if (segHitsRect(xs[xi], ys[yi], xs[xj], ys[yj], r)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      const len = Math.abs(xs[xj] - xs[xi]) + Math.abs(ys[yj] - ys[yi]);
      const cost = dist[u] + len + (nd === d ? 0 : BEND);
      const v = sid(xj, yj, nd);
      if (cost < dist[v] - 1e-9) {
        dist[v] = cost;
        prev[v] = u;
      }
    }
  }
  // 到着は相手アンカーの外向きと逆方向で入るのが自然 (違えば曲がり1回ぶん加算)
  const endDir = DIRS.findIndex(([dx, dy]) => dx === -bdx && dy === -bdy);
  let bestEnd = -1;
  let bestCost = Infinity;
  for (let d = 0; d < 4; d++) {
    const v = sid(x2i, y2i, d);
    if (dist[v] === Infinity) continue;
    const c = dist[v] + (d === endDir ? 0 : BEND);
    if (c < bestCost) {
      bestCost = c;
      bestEnd = v;
    }
  }
  if (bestEnd < 0) return null;
  const rev: [number, number][] = [];
  for (let v = bestEnd; v >= 0; v = prev[v]) {
    const d = v % 4;
    const cell = (v - d) / 4;
    const xi = cell % nx;
    const yi = (cell - xi) / nx;
    rev.push([xs[xi], ys[yi]]);
  }
  rev.reverse();
  return simplifyPath([[a.x, a.y], ...rev, [b.x, b.y]]);
}
