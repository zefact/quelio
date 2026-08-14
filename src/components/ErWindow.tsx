import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  deleteErDiagram,
  foreignKeys,
  getAppSettings,
  getErDiagram,
  listErDiagrams,
  listSessions,
  saveCapture,
  saveErDiagram,
  schemaSnapshot,
} from "../api";
import { parseComment } from "../comment";
import { layoutEr } from "../erLayout";
import type {
  ErAnchorPoint,
  ErCustomEdge,
  ErDiagramData,
  ErEdgeStyle,
  ErFrame,
  ErPageData,
  FkInfo,
  SchemaEntry,
  SessionSummary,
} from "../types";
import { SelectMenu } from "./SelectMenu";

/** ER図のノードに表示するカラム */
interface ErColumn {
  name: string;
  isPk: boolean;
  /** NOT NULL制約があるか */
  notNull: boolean;
  /** 型・サイズ (表示オプションOFFなら空) */
  type: string;
  /** 日本語名 (コメントの論理名。表示オプションOFFなら空) */
  logical: string;
}

/** カラム先頭のマーク (● = NOT NULL / ○ = NULL許容。PKは色で区別) */
function colMarker(c: ErColumn): string {
  return c.isPk || c.notNull ? "● " : "○ ";
}

/** ER図のノード (テーブル) */
interface ErNode {
  name: string;
  /** テーブルの日本語名 (コメントの論理名。表示オプションOFFなら空) */
  logical: string;
  /** 表示するカラム (PKのみ or 全カラム) */
  columns: ErColumn[];
  w: number;
  h: number;
}

/** ER図のエッジ (リレーション)。from(参照元/子) → to(参照先/親) */
interface ErEdge {
  from: string;
  to: string;
  /** 参照元テーブル側の代表カラム (線の出発位置) */
  fromColumn: string;
  /** 参照先テーブル側の代表カラム (線の到達位置) */
  toColumn: string;
  label: string;
  /** FK制約ではなく命名からの推測か */
  guessed: boolean;
  /** 手動で追加した線か */
  manual?: boolean;
}

/** 枠線の色プリセット (先頭の空文字は既定のグレー) */
const FRAME_COLORS = [
  "",
  "#6366f1",
  "#22d3ee",
  "#34d399",
  "#fbbf24",
  "#f87171",
  "#f472b6",
] as const;

/** 背景塗りの透明度 */
const FILL_ALPHA = 0.25;

/** #rrggbb をアルファ付きrgba()にする */
function hexAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** エッジの識別キー (削除の記憶に使う) */
function edgeKey(e: {
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
}): string {
  return `${e.from}.${e.fromColumn}->${e.to}.${e.toColumn}`;
}

/** スキーマ+表示オプションからノード一覧を組み立てる */
function buildNodes(
  entries: SchemaEntry[],
  allCols: boolean,
  showTypes: boolean,
  showLogical: boolean,
  delim: string
): ErNode[] {
  return entries.map((e) => {
    const all: ErColumn[] = e.detail.columns.map((c) => ({
      name: c.name,
      isPk: c.key === "PRI",
      notNull: !c.nullable,
      type: showTypes ? c.colType : "",
      logical: showLogical ? parseComment(c.comment ?? "", delim)[0] : "",
    }));
    const columns = allCols ? all : all.filter((c) => c.isPk);
    // テーブルの日本語名 (テーブルコメントの論理名)
    const tableComment =
      e.detail.info.find(([label]) => label === "コメント")?.[1] ?? "";
    const logical = showLogical ? parseComment(tableComment, delim)[0] : "";
    return {
      name: e.table.name,
      logical,
      columns,
      w: nodeWidth(e.table.name, logical, columns),
      h: NODE_HEAD_H + columns.length * ROW_H + NODE_PAD_B,
    };
  });
}

/** カラム行の中心Y座標 (表示中でなければヘッダ中心) */
function anchorY(n: ErNode, topY: number, col: string): number {
  const i = n.columns.findIndex((c) => c.name === col);
  return i >= 0
    ? topY + NODE_HEAD_H + i * ROW_H + ROW_H / 2
    : topY + NODE_HEAD_H / 2;
}

/** 鍵線 (直角折れ線) の経路を計算する。座標はノード左上+アンカーYで渡す */
function edgePoints(
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

const NODE_HEAD_H = 26;
const ROW_H = 17;
const NODE_PAD_B = 6;

/** 線の交差を飛び越える半円の半径 */
const HOP_R = 6;

/** 折れ線から垂直区間を抜き出す */
function verticalSegments(
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
function edgePath(
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
interface AnchoredPt {
  x: number;
  y: number;
  side: ErAnchorPoint["side"];
}

/** アンカー指定 (辺+割合) をテーブル境界上の座標にする */
function anchorPointPos(
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
function colSideAnchor(
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
function nearestBorderAnchor(
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
const STUB = 24;

/** 辺の外向き単位ベクトル */
function sideDir(s: ErAnchorPoint["side"]): [number, number] {
  return s === "left"
    ? [-1, 0]
    : s === "right"
      ? [1, 0]
      : s === "top"
        ? [0, -1]
        : [0, 1];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 直交線分が矩形の内部を通るか (境界上をなぞるだけなら通らない扱い) */
function segHitsRect(
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
function pathClear(pts: [number, number][], rects: Rect[]): boolean {
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
function simplifyPath(pts: [number, number][]): [number, number][] {
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
function routeAnchored(a: AnchoredPt, b: AnchoredPt): [number, number][] {
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
function routeAvoid(
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

/** 全角文字を2文字ぶんとして数える概算幅 */
function charUnits(text: string): number {
  let units = 0;
  for (const ch of text) {
    units += ch.charCodeAt(0) > 0xff ? 2 : 1;
  }
  return units;
}

/** カラム表示内容の概算幅からノード幅を決める (等幅11px想定)。
 * 名前・型・日本語名は縦列で揃えるため、それぞれの最大幅の合計で見積もる */
function nodeWidth(name: string, logical: string, cols: ErColumn[]): number {
  const maxName = Math.max(
    charUnits(name) + (logical ? charUnits(logical) + 2 : 0) + 2,
    ...cols.map((c) => charUnits(c.name) + 3)
  );
  const maxType = Math.max(0, ...cols.map((c) => charUnits(c.type)));
  const maxLogical = Math.max(0, ...cols.map((c) => charUnits(c.logical)));
  const units =
    maxName + (maxType > 0 ? maxType + 2 : 0) + (maxLogical > 0 ? maxLogical + 2 : 0);
  // 日本語名が「...」で切れないよう上限は広めに取る
  return Math.min(760, Math.max(140, 18 + units * 7.2));
}

/** FK + 命名推測からエッジ一覧を作る */
function buildEdges(entries: SchemaEntry[], fks: FkInfo[]): ErEdge[] {
  const tableNames = new Set(entries.map((e) => e.table.name));
  const edges: ErEdge[] = [];
  const seen = new Set<string>();
  const pairHasFk = new Set<string>();

  const push = (e: ErEdge) => {
    const key = `${e.from}->${e.to}:${e.label}`;
    if (e.from === e.to || seen.has(key)) return;
    seen.add(key);
    edges.push(e);
  };

  // FK制約
  for (const fk of fks) {
    if (!tableNames.has(fk.table) || !tableNames.has(fk.refTable)) continue;
    push({
      from: fk.table,
      to: fk.refTable,
      fromColumn: fk.column,
      toColumn: fk.refColumn,
      label: `${fk.column} → ${fk.refColumn}`,
      guessed: false,
    });
    pairHasFk.add(`${fk.table}->${fk.refTable}`);
  }

  // 命名からの推測
  const colsOf = new Map<string, Set<string>>();
  const pkOf = new Map<string, string[]>();
  for (const e of entries) {
    colsOf.set(e.table.name, new Set(e.detail.columns.map((c) => c.name)));
    pkOf.set(
      e.table.name,
      e.detail.columns.filter((c) => c.key === "PRI").map((c) => c.name)
    );
  }

  for (const target of entries) {
    const t = target.table.name;
    const pk = pkOf.get(t) ?? [];
    // ルール1: 参照先のPKカラム一式(1〜3個・"id"単独は除く)を全て持つテーブルを子とみなす
    const pkDistinctive =
      pk.length >= 1 && pk.length <= 3 && !(pk.length === 1 && pk[0] === "id");
    if (pkDistinctive) {
      for (const src of entries) {
        const u = src.table.name;
        if (u === t || pairHasFk.has(`${u}->${t}`)) continue;
        const cols = colsOf.get(u)!;
        if (pk.every((p) => cols.has(p))) {
          push({
            from: u,
            to: t,
            fromColumn: pk[pk.length - 1],
            toColumn: pk[pk.length - 1],
            label: pk.join(", "),
            guessed: true,
          });
        }
      }
    }
    // ルール2: 「xxx_id」カラム → PKが(id)のテーブル xxx / m_xxx / t_xxx / xxxs
    if (pk.length === 1 && pk[0] === "id") {
      const bases = [t, t.replace(/^m_/, ""), t.replace(/^t_/, ""), t.replace(/s$/, "")];
      for (const src of entries) {
        const u = src.table.name;
        if (u === t || pairHasFk.has(`${u}->${t}`)) continue;
        for (const col of colsOf.get(u)!) {
          if (!col.endsWith("_id")) continue;
          const base = col.slice(0, -3);
          if (bases.includes(base)) {
            push({
              from: u,
              to: t,
              fromColumn: col,
              toColumn: "id",
              label: `${col} → id`,
              guessed: true,
            });
          }
        }
      }
    }
  }
  return edges;
}

/** ER図ウィンドウ (DB全体のテーブルとリレーションを描画・PNG出力) */
export function ErWindow() {
  const params = new URLSearchParams(window.location.search);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sel, setSel] = useState({
    sessionId: params.get("session") ?? "",
    database: params.get("db") ?? "",
  });
  const [entries, setEntries] = useState<SchemaEntry[] | null>(null);
  const [fks, setFks] = useState<FkInfo[]>([]);
  // 表示オプション (新規作成時の既定は全てON。保存済みの図を開くと上書きされる)
  const [allCols, setAllCols] = useState(true);
  const [showLogical, setShowLogical] = useState(true);
  const [showTypes, setShowTypes] = useState(true);
  /** 表示設定プルダウンの開閉 */
  const [optsOpen, setOptsOpen] = useState(false);
  const optsRef = useRef<HTMLDivElement>(null);
  /** 論理名の区切り文字 (設定から読み込む) */
  const [delim, setDelim] = useState("（");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ドラッグで動かしたノードの位置 (自動レイアウトへの上書き。state更新は再描画トリガrevで行う)
  const posRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [rev, setRev] = useState(0);
  // 表示変換 (パン・ズーム)
  const [view, setView] = useState({ x: 40, y: 20, scale: 0.8 });
  const canvasRef = useRef<HTMLDivElement>(null);

  const session = sessions.find((s) => s.sessionId === sel.sessionId);

  useEffect(() => {
    getAppSettings()
      .then((s) => setDelim(s.commentDelimiter))
      .catch(() => {});
  }, []);

  // 接続一覧は定期的に再取得する。
  // スキーマ読み込み中のセッションは一覧から一時的に外れるため、
  // 開いた直後の1回だけだと空のまま固まってしまう
  useEffect(() => {
    const refresh = () => listSessions().then(setSessions).catch(() => {});
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, []);

  // 開いている図の名前 (=保存キー)。プロファイルに縛られず自由に付けられ、
  // どの接続からでも同じ図を開ける
  const [diagName, setDiagName] = useState<string | null>(null);
  const diagNameRef = useRef<string | null>(null);
  diagNameRef.current = diagName;
  /** 保存済みの図の名前一覧 */
  const [diagList, setDiagList] = useState<string[]>([]);
  const refreshDiagList = () =>
    listErDiagrams().then(setDiagList).catch(() => {});
  /** 図メニューの開閉 */
  const [diagMenuOpen, setDiagMenuOpen] = useState(false);
  const diagMenuRef = useRef<HTMLDivElement>(null);
  /** 図の名前入力ダイアログ (名前を付けて保存 / 名前変更) */
  const [nameDialog, setNameDialog] = useState<{
    mode: "saveAs" | "rename";
    value: string;
  } | null>(null);
  /** リバース時の確認ダイアログ (既存の図がある場合のみ表示) */
  const [reverseDialog, setReverseDialog] = useState(false);
  /** リバース時に削除済みテーブルも復活させるか (ダイアログのチェック) */
  const [reviveTables, setReviveTables] = useState(false);
  /** 削除確認ダイアログ (タブ・テーブル・線・枠などの削除前に出す)。
   * subを指定するとサブテキストを差し替えられる (既定は「元に戻せません」) */
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    sub?: string;
    action: () => void;
  } | null>(null);
  // ---- ページ (タブ)。1つの保存ファイルに複数のER図を持てる ----
  const [pages, setPages] = useState<{ id: string; name: string }[]>([
    { id: "p1", name: "ER図1" },
  ]);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const [pageId, setPageId] = useState("p1");
  const pageIdRef = useRef(pageId);
  pageIdRef.current = pageId;
  /** 非アクティブページの内容 (アクティブページは各stateが持つ) */
  const pagesDataRef = useRef<Map<string, ErPageData>>(new Map());
  /** タブ名のインライン編集 */
  const [tabEditingId, setTabEditingId] = useState<string | null>(null);
  const [tabEditText, setTabEditText] = useState("");
  /** ドラッグで並べ替え中のタブindex */
  const dragTabIdxRef = useRef<number | null>(null);
  // 保存用に最新のスキーマを参照できるようにしておく (ドラッグ終了時などに使う)
  const entriesRef = useRef<SchemaEntry[] | null>(null);
  entriesRef.current = entries;
  const fksRef = useRef<FkInfo[]>([]);
  fksRef.current = fks;
  /** 全体フィット表示のトリガ (読み込み/新規作成時に+1する) */
  const [fitTick, setFitTick] = useState(0);
  /** 選択中のリレーション (edgesのindex。背景クリックで解除) */
  const [selEdge, setSelEdge] = useState<number | null>(null);
  /** 複数選択中のリレーション (Shift+ドラッグの矩形選択で入る) */
  const [selEdges, setSelEdges] = useState<Set<number>>(new Set());
  /** 選択中のテーブル (複数可。背景クリックで解除) */
  const [selNodes, setSelNodes] = useState<Set<string>>(new Set());
  /** 矩形選択中の範囲 (ワールド座標) */
  const [band, setBand] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  /** 選択中のカラム行 (クリックで選択。もう一度クリック/背景クリックで解除) */
  const [selCol, setSelCol] = useState<{
    table: string;
    column: string;
  } | null>(null);
  /** 削除した自動検出リレーションのキー */
  const [removedEdges, setRemovedEdges] = useState<Set<string>>(new Set());
  /** 図から削除したテーブル名 (リバースしても再追加しない) */
  const [removedTables, setRemovedTables] = useState<Set<string>>(new Set());
  /** テーブルごとの横幅の上書き (px。未設定は内容に合わせて自動=Fit) */
  const [tableWidths, setTableWidths] = useState<Record<string, number>>({});
  /** 手動で追加したリレーション */
  const [customEdges, setCustomEdges] = useState<ErCustomEdge[]>([]);
  /** 線ごとの接続位置の上書き (キーはedgeKey) */
  const [anchors, setAnchors] = useState<
    Record<string, { from?: ErAnchorPoint; to?: ErAnchorPoint }>
  >({});
  /** 線に対応するカラムの追加分 (キーはedgeKey。複合キーなどの複数対応) */
  const [edgeCols, setEdgeCols] = useState<
    Record<string, { from: string[]; to: string[] }>
  >({});
  /** 線ごとの見た目 (キーはedgeKey。線種・色) */
  const [edgeStyles, setEdgeStyles] = useState<Record<string, ErEdgeStyle>>(
    {}
  );
  /** 線の追加モード (接続元→接続先の順にカラムをクリック) */
  const [linkMode, setLinkMode] = useState(false);
  const [linkSrc, setLinkSrc] = useState<{
    table: string;
    column: string;
  } | null>(null);
  /** ホバー中のカラム行 (両端に線をつなぐ●ハンドルを出す) */
  const [hoverCol, setHoverCol] = useState<{
    table: string;
    column: string;
    idx: number;
  } | null>(null);
  /** ●ハンドルからのドラッグ接続 (プレビュー線と接続先ハイライト) */
  const [linkDrag, setLinkDrag] = useState<{
    from: { table: string; column: string };
    x: number;
    y: number;
    target: { table: string; column: string } | null;
  } | null>(null);
  /** 線の編集パネル (カラムの対応をチェックボックスで設定) */
  const [edgePanel, setEdgePanel] = useState<{
    edge: number;
    x: number;
    y: number;
  } | null>(null);
  /** 注釈枠 */
  const [frames, setFrames] = useState<ErFrame[]>([]);
  /** インライン編集中の枠/テキストのID (画面上で直接編集する) */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  /** 右クリックメニュー */
  const [ctxMenu, setCtxMenu] = useState<
    | { x: number; y: number; kind: "edge"; edge: number }
    | { x: number; y: number; kind: "column"; table: string; column: string }
    | { x: number; y: number; kind: "frame"; frameId: string }
    | { x: number; y: number; kind: "node"; table: string }
    | { x: number; y: number; kind: "canvas"; worldX: number; worldY: number }
    | null
  >(null);

  /** 現在の状態を自動保存する */
  const persist = useCallback(
    (
      ents: SchemaEntry[],
      fkList: FkInfo[],
      positions: Map<string, { x: number; y: number }>,
      opts?: { allCols: boolean; showLogical: boolean; showTypes: boolean },
      edgeOverride?: {
        removed?: Set<string>;
        removedTables?: Set<string>;
        tableWidths?: Record<string, number>;
        custom?: ErCustomEdge[];
        frames?: ErFrame[];
        anchors?: Record<string, { from?: ErAnchorPoint; to?: ErAnchorPoint }>;
        edgeCols?: Record<string, { from: string[]; to: string[] }>;
        edgeStyles?: Record<string, ErEdgeStyle>;
      }
    ) => {
      const key = diagNameRef.current;
      if (!key) return;
      // アクティブページの内容を組み立ててページ一覧へ反映し、全ページを保存する
      const pageName =
        pagesRef.current.find((p) => p.id === pageIdRef.current)?.name ??
        "ER図1";
      const active: ErPageData = {
        id: pageIdRef.current,
        name: pageName,
        entries: ents,
        fks: fkList,
        positions: Object.fromEntries(positions),
        options: opts ?? { allCols, showLogical, showTypes },
        removedEdges: [...(edgeOverride?.removed ?? removedEdges)],
        removedTables: [...(edgeOverride?.removedTables ?? removedTables)],
        tableWidths: edgeOverride?.tableWidths ?? tableWidths,
        customEdges: edgeOverride?.custom ?? customEdges,
        anchors: edgeOverride?.anchors ?? anchors,
        edgeColumns: edgeOverride?.edgeCols ?? edgeCols,
        edgeStyles: edgeOverride?.edgeStyles ?? edgeStyles,
        frames: edgeOverride?.frames ?? frames,
      };
      pagesDataRef.current.set(active.id, active);
      saveErDiagram(key, assembleFileData()).catch(() => {});
    },
    [
      allCols,
      showLogical,
      showTypes,
      removedEdges,
      removedTables,
      tableWidths,
      customEdges,
      anchors,
      edgeCols,
      edgeStyles,
      frames,
    ]
  );

  /** 空ページの内容 */
  const emptyPageData = (id: string, name: string): ErPageData => ({
    id,
    name,
    entries: [],
    fks: [],
    positions: {},
  });

  /** 現在の状態からアクティブページの保存内容を組み立てる */
  const buildPageData = (): ErPageData => ({
    id: pageIdRef.current,
    name:
      pagesRef.current.find((p) => p.id === pageIdRef.current)?.name ??
      "ER図1",
    entries: entriesRef.current ?? [],
    fks: fksRef.current,
    positions: Object.fromEntries(posRef.current),
    options: { allCols, showLogical, showTypes },
    removedEdges: [...removedEdges],
    removedTables: [...removedTables],
    tableWidths,
    customEdges,
    anchors,
    edgeColumns: edgeCols,
    edgeStyles,
    frames,
  });

  /** pagesDataRefとページ一覧からファイル全体の保存データを組み立てる。
   * 呼び出し前にアクティブページをpagesDataRefへ反映しておくこと */
  function assembleFileData(): ErDiagramData {
    const metas = pagesRef.current;
    const list = metas.map((p) => {
      const d = pagesDataRef.current.get(p.id) ?? emptyPageData(p.id, p.name);
      return { ...d, id: p.id, name: p.name };
    });
    return {
      savedAtMs: Date.now(),
      pages: list,
      activePage: Math.max(
        0,
        metas.findIndex((p) => p.id === pageIdRef.current)
      ),
    };
  }

  /** ファイル全体を保存する (ページ操作後に使う。アクティブページはpagesDataRefから) */
  const saveFile = () => {
    const key = diagNameRef.current;
    if (!key) return;
    saveErDiagram(key, assembleFileData()).catch(() => {});
  };

  /** 現在の状態から保存データを組み立てる (名前を付けて保存などに使う) */
  const buildData = (): ErDiagramData => {
    pagesDataRef.current.set(pageIdRef.current, buildPageData());
    return assembleFileData();
  };

  /** ページの内容を各stateへ反映する */
  const applyPageData = (d: ErPageData) => {
    posRef.current = new Map(Object.entries(d.positions ?? {}));
    if (d.options) {
      setAllCols(d.options.allCols);
      setShowLogical(d.options.showLogical);
      setShowTypes(d.options.showTypes);
    } else {
      setAllCols(true);
      setShowLogical(true);
      setShowTypes(true);
    }
    setRemovedEdges(new Set(d.removedEdges ?? []));
    setRemovedTables(new Set(d.removedTables ?? []));
    setTableWidths(d.tableWidths ?? {});
    setCustomEdges(d.customEdges ?? []);
    setAnchors(d.anchors ?? {});
    setEdgeCols(d.edgeColumns ?? {});
    setEdgeStyles(d.edgeStyles ?? {});
    setFrames(d.frames ?? []);
    setEntries(d.entries.length > 0 ? d.entries : null);
    setFks(d.fks ?? []);
    setSelEdge(null);
    setSelEdges(new Set());
    setSelNodes(new Set());
    setSelCol(null);
    setRev((r) => r + 1);
  };

  /** キャンバスを空の未保存状態に戻す (表示オプションも既定に戻す) */
  const clearDiagram = () => {
    const pid = `p${Date.now()}`;
    const meta = [{ id: pid, name: "ER図1" }];
    pagesDataRef.current = new Map();
    setPages(meta);
    pagesRef.current = meta;
    setPageId(pid);
    pageIdRef.current = pid;
    applyPageData(emptyPageData(pid, "ER図1"));
    setDiagName(null);
  };

  /** 保存済みの図を名前で開く (どの接続からでも開ける) */
  const openDiagram = (name: string) => {
    setError(null);
    getErDiagram(name)
      .then((data) => {
        if (!data) return;
        // 旧形式 (単一ページ) は1ページに移行して読み込む
        const pageList: ErPageData[] =
          data.pages && data.pages.length > 0
            ? data.pages
            : [
                {
                  id: "p1",
                  name: "ER図1",
                  entries: data.entries ?? [],
                  fks: data.fks ?? [],
                  positions: data.positions ?? {},
                  options: data.options,
                  removedEdges: data.removedEdges,
                  removedTables: data.removedTables,
                  tableWidths: data.tableWidths,
                  customEdges: data.customEdges,
                  anchors: data.anchors,
                  edgeColumns: data.edgeColumns,
                  edgeStyles: data.edgeStyles,
                  frames: data.frames,
                },
              ];
        pagesDataRef.current = new Map(pageList.map((p) => [p.id, p]));
        const metas = pageList.map((p) => ({ id: p.id, name: p.name }));
        setPages(metas);
        pagesRef.current = metas;
        const idx = Math.min(data.activePage ?? 0, pageList.length - 1);
        const act = pageList[idx];
        setPageId(act.id);
        pageIdRef.current = act.id;
        applyPageData(act);
        setDiagName(name);
        setNotice(null);
        setFitTick((t) => t + 1);
      })
      .catch(() => {});
  };

  // ---- ページ (タブ) の操作 ----

  /** タブを切り替える (現在ページの内容は退避して保存) */
  const switchPage = (id: string) => {
    if (id === pageIdRef.current) return;
    pagesDataRef.current.set(pageIdRef.current, buildPageData());
    const meta = pagesRef.current.find((p) => p.id === id);
    const target =
      pagesDataRef.current.get(id) ?? emptyPageData(id, meta?.name ?? "ER図");
    setPageId(id);
    pageIdRef.current = id;
    applyPageData(target);
    setFitTick((t) => t + 1);
    saveFile();
  };

  /** タブを追加して切り替える */
  const addPage = () => {
    pagesDataRef.current.set(pageIdRef.current, buildPageData());
    const id = `p${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
    const name = `ER図${pagesRef.current.length + 1}`;
    const meta = [...pagesRef.current, { id, name }];
    setPages(meta);
    pagesRef.current = meta;
    pagesDataRef.current.set(id, emptyPageData(id, name));
    setPageId(id);
    pageIdRef.current = id;
    applyPageData(emptyPageData(id, name));
    saveFile();
  };

  /** タブの削除を確認してから実行する */
  const deletePage = (id: string) => {
    if (pagesRef.current.length <= 1) return;
    const name = pagesRef.current.find((p) => p.id === id)?.name ?? id;
    setConfirm({
      title: "タブを削除",
      message: `タブ「${name}」とその内容を削除しますか？この操作は元に戻せません。`,
      action: () => doDeletePage(id),
    });
  };

  /** タブを削除する (最後の1つは削除不可) */
  const doDeletePage = (id: string) => {
    if (pagesRef.current.length <= 1) return;
    const target = pagesRef.current.find((p) => p.id === id);
    const next = pagesRef.current.filter((p) => p.id !== id);
    pagesDataRef.current.delete(id);
    setPages(next);
    pagesRef.current = next;
    if (pageIdRef.current === id) {
      const act = next[0];
      setPageId(act.id);
      pageIdRef.current = act.id;
      applyPageData(
        pagesDataRef.current.get(act.id) ?? emptyPageData(act.id, act.name)
      );
    }
    saveFile();
    setNotice(`タブ「${target?.name ?? id}」を削除しました`);
  };

  /** タブの並べ替え (ドラッグ中にindexを入れ替える) */
  const reorderPages = (from: number, to: number) => {
    const next = [...pagesRef.current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setPages(next);
    pagesRef.current = next;
  };

  /** タブ名の変更を確定する */
  const commitTabRename = () => {
    if (tabEditingId === null) return;
    const name = tabEditText.trim();
    if (name) {
      const next = pagesRef.current.map((p) =>
        p.id === tabEditingId ? { ...p, name } : p
      );
      setPages(next);
      pagesRef.current = next;
      pagesDataRef.current.set(pageIdRef.current, buildPageData());
      saveFile();
    }
    setTabEditingId(null);
  };

  // 起動時に図の一覧を読み込む
  useEffect(() => {
    refreshDiagList();
  }, []);

  // 通知は右上のトーストとして表示し、5秒で自動的に消す
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // ページ内検索 (⌘F) がER図内の一致へ移動するとき、キャンバスをパンして
  // 一致位置を中央に表示する (ズームは変えない)
  useEffect(() => {
    const onReveal = (e: Event) => {
      const el = (e as CustomEvent).detail as HTMLElement | null;
      const canvas = canvasRef.current;
      if (!el || !canvas || !canvas.contains(el)) return;
      const r = el.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      const dx = c.left + c.width / 2 - (r.left + r.width / 2);
      const dy = c.top + c.height / 2 - (r.top + r.height / 2);
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    };
    window.addEventListener("quelio-find-reveal-er", onReveal);
    return () => window.removeEventListener("quelio-find-reveal-er", onReveal);
  }, []);

  // タブの並べ替えドラッグ終了時に保存する
  const saveAfterTabDragRef = useRef(() => {});
  saveAfterTabDragRef.current = () => {
    pagesDataRef.current.set(pageIdRef.current, buildPageData());
    saveFile();
  };
  useEffect(() => {
    const up = () => {
      if (dragTabIdxRef.current !== null) {
        dragTabIdxRef.current = null;
        saveAfterTabDragRef.current();
      }
    };
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  }, []);

  // 開いたときに、この接続/DBに対応する図が保存済みなら自動で開く
  // (旧形式の「プロファイルID:DB名」キーも引き続き開ける)
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current || diagName || !session || !sel.database) return;
    if (diagList.length === 0) return;
    const candidates = [
      `${session.name}/${sel.database}`,
      `${session.profileId}:${sel.database}`,
    ];
    const hit = candidates.find((c) => diagList.includes(c));
    if (hit) {
      autoOpenedRef.current = true;
      openDiagram(hit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sel.database, diagList, diagName]);

  /** 名前ダイアログの確定 (名前を付けて保存 / 名前変更) */
  const commitNameDialog = () => {
    if (!nameDialog) return;
    const name = nameDialog.value.trim();
    if (!name) return;
    const old = diagNameRef.current;
    const mode = nameDialog.mode;
    setNameDialog(null);
    saveErDiagram(name, buildData())
      .then(async () => {
        if (mode === "rename" && old && old !== name) {
          await deleteErDiagram(old).catch(() => {});
        }
        diagNameRef.current = name;
        setDiagName(name);
        refreshDiagList();
        setNotice(`「${name}」として保存しました`);
      })
      .catch((e) => setNotice(`保存に失敗: ${e}`));
  };

  /** 現在の図の削除を確認してから実行する */
  const deleteCurrentDiagram = () => {
    const name = diagNameRef.current;
    if (!name) return;
    setConfirm({
      title: "図を削除",
      message: `「${name}」を全てのタブごと削除しますか？この操作は元に戻せません。`,
      action: () => {
        deleteErDiagram(name)
          .then(() => refreshDiagList())
          .catch(() => {});
        clearDiagram();
        setNotice(`「${name}」を削除しました`);
      },
    });
  };

  /** リバース: DBからスキーマを読み込んでER図を作成/更新する。
   * 既存の図がある場合はテーブルの配置を維持し、新規テーブルは右側へ追加する。
   * addNew: 図に無い新規テーブルを追加するか (既存図でundefinedなら確認ダイアログを出す)
   * revive: 図から削除したテーブルも復活させるか */
  const doReverse = async (addNew?: boolean, revive?: boolean) => {
    if (!sel.sessionId || !sel.database) return;
    // 既にテーブルがある場合は、新規テーブルの扱いを確認してから実行する
    if (
      addNew === undefined &&
      entriesRef.current !== null &&
      posRef.current.size > 0
    ) {
      setReviveTables(false);
      setReverseDialog(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [snapAll, fk] = await Promise.all([
        schemaSnapshot(sel.sessionId, sel.database),
        foreignKeys(sel.sessionId, sel.database),
      ]);
      // 図から削除したテーブルはリバースしても再追加しない
      // (reviveチェック時は削除の記憶を解除して復活させる)
      const removedNow = revive ? new Set<string>() : removedTables;
      if (revive && removedTables.size > 0) setRemovedTables(new Set());
      let snap = snapAll.filter((e) => !removedNow.has(e.table.name));
      // 「いいえ」= 図にあるテーブルだけ更新 (カラムの増減は反映、新規テーブルは追加しない)
      // reviveチェック時は削除済みだったテーブルも対象に含める
      if (addNew === false && entriesRef.current) {
        const allowed = new Set(entriesRef.current.map((e) => e.table.name));
        if (revive) for (const n of removedTables) allowed.add(n);
        snap = snap.filter((e) => allowed.has(e.table.name));
      }
      const freshNodes = buildNodes(snap, allCols, showTypes, showLogical, delim);
      const freshEdges = buildEdges(snap, fk);
      const prev = posRef.current;
      const isUpdate = entriesRef.current !== null && prev.size > 0;
      let positions: Map<string, { x: number; y: number }>;
      const addedNames: string[] = [];
      if (!isUpdate) {
        // 新規作成: 自動レイアウト
        positions = layoutEr(freshNodes, freshEdges);
      } else {
        // 更新: 既存テーブルの配置を維持し、新規テーブルは右側へ縦積み
        positions = new Map();
        let maxX = 0;
        for (const n of freshNodes) {
          const p = prev.get(n.name);
          if (p) {
            positions.set(n.name, p);
            maxX = Math.max(maxX, p.x + n.w);
          }
        }
        let y = 20;
        for (const n of freshNodes) {
          if (positions.has(n.name)) continue;
          positions.set(n.name, { x: maxX + 80, y });
          y += n.h + 40;
          addedNames.push(n.name);
        }
      }
      posRef.current = positions;
      setEntries(snap);
      setFks(fk);
      setRev((r) => r + 1);
      if (!isUpdate) setFitTick((t) => t + 1);
      // 図の名前が未設定なら「接続名/DB名」で自動命名する (重複時は連番)
      let name = diagNameRef.current;
      if (!name) {
        const base = `${session?.name ?? "ER図"}/${sel.database}`;
        name = base;
        let n = 2;
        while (diagList.includes(name)) name = `${base} (${n++})`;
        diagNameRef.current = name;
        setDiagName(name);
      }
      persist(
        snap,
        fk,
        positions,
        undefined,
        revive ? { removedTables: removedNow } : undefined
      );
      refreshDiagList();
      // 追加されたテーブル名を通知する (多い場合は先頭数件+件数)
      const shown = addedNames.slice(0, 6).join(", ");
      const more =
        addedNames.length > 6 ? ` 他${addedNames.length - 6}件` : "";
      setNotice(
        isUpdate
          ? addedNames.length > 0
            ? `更新しました — 新規${addedNames.length}テーブル: ${shown}${more}`
            : "更新しました"
          : `「${name}」として保存しました`
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      // 読み込み中はこのセッションが接続一覧から外れているため取り直す
      listSessions().then(setSessions).catch(() => {});
    }
  };

  // ノードとエッジの組み立て (横幅の上書きがあれば適用。未設定は内容にFit)
  const nodes: ErNode[] = useMemo(() => {
    if (!entries) return [];
    return buildNodes(entries, allCols, showTypes, showLogical, delim).map(
      (n) => (tableWidths[n.name] ? { ...n, w: tableWidths[n.name] } : n)
    );
  }, [entries, allCols, showTypes, showLogical, delim, tableWidths]);

  const edges = useMemo(() => {
    if (!entries) return [];
    const tableSet = new Set(entries.map((e) => e.table.name));
    // 自動検出 (削除済みは除く) + 手動追加 (存在するテーブルのみ)
    const auto = buildEdges(entries, fks).filter(
      (e) => !removedEdges.has(edgeKey(e))
    );
    const manual: ErEdge[] = customEdges
      .filter((c) => tableSet.has(c.from) && tableSet.has(c.to))
      .map((c) => ({
        from: c.from,
        to: c.to,
        fromColumn: c.fromColumn,
        toColumn: c.toColumn,
        label: `${c.fromColumn} → ${c.toColumn} (手動)`,
        guessed: false,
        manual: true,
      }));
    return [...auto, ...manual];
  }, [entries, fks, removedEdges, customEdges]);

  /** ノードの表示位置 (リバース/読み込みで確定した配置。ドラッグで上書き) */
  const posOf = (name: string): { x: number; y: number } =>
    posRef.current.get(name) ?? { x: 20, y: 20 };

  // 読み込み/新規作成の直後は全体が画面に収まるように表示を合わせる。
  // (テーブル数の増減だけではフィットし直さない。fitTickが進んだときのみ)
  const doneFitRef = useRef(0);
  useEffect(() => {
    if (fitTick === 0 || nodes.length === 0) return;
    if (doneFitRef.current === fitTick) return;
    doneFitRef.current = fitTick;
    const el = canvasRef.current;
    if (!el) return;
    let maxX = 400;
    let maxY = 300;
    for (const nd of nodes) {
      const p = posRef.current.get(nd.name);
      if (!p) continue;
      maxX = Math.max(maxX, p.x + nd.w);
      maxY = Math.max(maxY, p.y + nd.h);
    }
    const rect = el.getBoundingClientRect();
    const scale = Math.min(
      1,
      (rect.width - 40) / (maxX + 40),
      (rect.height - 40) / (maxY + 40)
    );
    setView({ x: 20, y: 20, scale: Math.max(0.12, scale) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitTick, nodes.length]);

  // ホイール/トラックパッド操作 (passiveでないリスナが必要なためrefに直接付ける)。
  // キャンバスは読み込み完了後にしかDOMに存在しないため、表示状態が変わるたびに付け直す
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // ピンチ (ctrlKey付きwheel) / ⌘・Ctrl+スクロール = ズーム、通常のスクロール = パン
      if (e.ctrlKey || e.metaKey) {
        setView((v) => {
          const factor = Math.exp(-e.deltaY * 0.01);
          const scale = Math.min(2.5, Math.max(0.12, v.scale * factor));
          const rect = el.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          return {
            scale,
            x: mx - ((mx - v.x) * scale) / v.scale,
            y: my - ((my - v.y) * scale) / v.scale,
          };
        });
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [entries, loading]);

  /** テーブルを図から削除する (複数可。リバースしても再追加されない) */
  const removeTables = (names: string[]) => deleteSelection([], names);

  /** 削除したテーブルの記憶を解除する (次のリバースで再追加される) */
  const restoreRemovedTables = () => {
    if (removedTables.size === 0) return;
    setRemovedTables(new Set());
    setNotice("削除したテーブルを戻しました。リバースすると再表示されます");
    if (entriesRef.current) {
      persist(entriesRef.current, fksRef.current, posRef.current, undefined, {
        removedTables: new Set(),
      });
    }
  };

  /** ノードのドラッグ移動 (ヘッダ・カラム部どこからでも掴める)。
   * 複数選択中に選択済みのテーブルを掴むと、選択中の全テーブルをまとめて動かす。
   * カラム行の上から始めた場合はテーブル選択にせず行クリックを優先する */
  const startNodeDrag = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    const t = e.target as HTMLElement;
    let selected = selNodes;
    if (!t.closest(".er-col-name, .er-col-type, .er-col-logical")) {
      if (e.shiftKey) {
        // Shift+クリックで選択に追加/解除
        selected = new Set(selNodes);
        if (selected.has(name)) selected.delete(name);
        else selected.add(name);
        setSelNodes(selected);
      } else if (!selNodes.has(name)) {
        selected = new Set([name]);
        setSelNodes(selected);
      }
    }
    // まとめて動かす対象 (選択中のテーブルを掴んだ場合は選択全体)
    const moveNames =
      selected.has(name) && selected.size > 1 ? [...selected] : [name];
    const start = { x: e.clientX, y: e.clientY };
    const origs = new Map(moveNames.map((nm) => [nm, posOf(nm)]));
    const move = (ev: MouseEvent) => {
      const dx = (ev.clientX - start.x) / view.scale;
      const dy = (ev.clientY - start.y) / view.scale;
      for (const [nm, o] of origs) {
        posRef.current.set(nm, { x: o.x + dx, y: o.y + dy });
      }
      setRev((r) => r + 1);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      // 配置の変更を自動保存する
      if (entriesRef.current) {
        persist(entriesRef.current, fksRef.current, posRef.current);
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** 指定のワールド座標にあるカラム行を返す (excludeTableは除く) */
  const hitColumn = (
    wx: number,
    wy: number,
    excludeTable: string
  ): { table: string; column: string } | null => {
    for (const n of nodes) {
      if (n.name === excludeTable) continue;
      const p = posOf(n.name);
      if (wx < p.x || wx > p.x + n.w || wy < p.y || wy > p.y + n.h) continue;
      const idx = Math.floor((wy - p.y - NODE_HEAD_H) / ROW_H);
      if (idx >= 0 && idx < n.columns.length) {
        return { table: n.name, column: n.columns[idx].name };
      }
      return null;
    }
    return null;
  };

  /** 手動リレーションを追加する (重複は追加しない) */
  const addCustomEdge = (
    fromT: string,
    fromC: string,
    toT: string,
    toC: string
  ) => {
    if (fromT === toT) return;
    const dup = edges.some(
      (e) =>
        e.from === fromT &&
        e.fromColumn === fromC &&
        e.to === toT &&
        e.toColumn === toC
    );
    if (dup) {
      setNotice("同じ対応の線が既にあります");
      return;
    }
    const c: ErCustomEdge = {
      from: fromT,
      fromColumn: fromC,
      to: toT,
      toColumn: toC,
    };
    const custom = [...customEdges, c];
    setCustomEdges(custom);
    setNotice(`${fromT}.${fromC} → ${toT}.${toC} を追加しました`);
    if (entriesRef.current) {
      persist(entriesRef.current, fksRef.current, posRef.current, undefined, {
        custom,
      });
    }
  };

  /** カラム行の●ハンドルからドラッグして線をつなぐ */
  const startLinkDrag = (
    e: React.MouseEvent,
    table: string,
    column: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const toWorld = (cx: number, cy: number) => ({
      x: (cx - rect.left - view.x) / view.scale,
      y: (cy - rect.top - view.y) / view.scale,
    });
    const p0 = toWorld(e.clientX, e.clientY);
    setLinkDrag({ from: { table, column }, x: p0.x, y: p0.y, target: null });
    const move = (ev: MouseEvent) => {
      const q = toWorld(ev.clientX, ev.clientY);
      setLinkDrag({
        from: { table, column },
        x: q.x,
        y: q.y,
        target: hitColumn(q.x, q.y, table),
      });
    };
    const up = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", move);
      const q = toWorld(ev.clientX, ev.clientY);
      const target = hitColumn(q.x, q.y, table);
      setLinkDrag(null);
      setHoverCol(null);
      if (target) addCustomEdge(table, column, target.table, target.column);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** テーブルの横幅を右端ドラッグで調整する */
  const startNodeResize = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    const node = nodes.find((n) => n.name === name);
    if (!node) return;
    const startX = e.clientX;
    const orig = node.w;
    let latest = tableWidths;
    const move = (ev: MouseEvent) => {
      const w = Math.round(
        Math.min(1200, Math.max(120, orig + (ev.clientX - startX) / view.scale))
      );
      latest = { ...tableWidths, [name]: w };
      setTableWidths(latest);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      if (entriesRef.current) {
        persist(entriesRef.current, fksRef.current, posRef.current, undefined, {
          tableWidths: latest,
        });
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** テーブルの横幅を自動 (Fit) に戻す */
  const resetTableWidth = (name: string) => {
    if (tableWidths[name] === undefined) return;
    const next = { ...tableWidths };
    delete next[name];
    setTableWidths(next);
    if (entriesRef.current) {
      persist(entriesRef.current, fksRef.current, posRef.current, undefined, {
        tableWidths: next,
      });
    }
  };

  /** 線とテーブルをまとめて削除する (一括選択のDelete用)。
   * 手動追加の線は一覧から外し、自動検出の線・テーブルは「削除済み」として
   * 記憶する (再リバースしても復活しない) */
  const deleteSelection = (edgeIdxs: number[], tableNames: string[]) => {
    const objs = edgeIdxs.map((i) => edges[i]).filter(Boolean);
    if (objs.length === 0 && tableNames.length === 0) return;
    // 線の削除
    const removed = new Set(removedEdges);
    let custom = customEdges;
    const nextAnchors = { ...anchors };
    const nextEdgeCols = { ...edgeCols };
    const nextEdgeStyles = { ...edgeStyles };
    for (const e of objs) {
      if (e.manual) {
        custom = custom.filter(
          (c) =>
            !(
              c.from === e.from &&
              c.to === e.to &&
              c.fromColumn === e.fromColumn &&
              c.toColumn === e.toColumn
            )
        );
      } else {
        removed.add(edgeKey(e));
      }
      // 付随する接続位置・対応カラム・線種の設定も一緒に削除する
      const key = edgeKey(e);
      delete nextAnchors[key];
      delete nextEdgeCols[key];
      delete nextEdgeStyles[key];
    }
    // テーブルの削除
    const nameSet = new Set(tableNames);
    const ents = (entriesRef.current ?? []).filter(
      (e) => !nameSet.has(e.table.name)
    );
    const removedT = new Set(removedTables);
    for (const n of tableNames) {
      removedT.add(n);
      posRef.current.delete(n);
    }
    setRemovedEdges(removed);
    setCustomEdges(custom);
    setAnchors(nextAnchors);
    setEdgeCols(nextEdgeCols);
    setEdgeStyles(nextEdgeStyles);
    if (tableNames.length > 0) {
      setRemovedTables(removedT);
      setEntries(ents);
    }
    setSelEdge(null);
    setSelEdges(new Set());
    setSelNodes(new Set());
    setRev((r) => r + 1);
    const parts: string[] = [];
    if (tableNames.length === 1) parts.push(`${tableNames[0]}`);
    else if (tableNames.length > 1) parts.push(`${tableNames.length}テーブル`);
    if (objs.length === 1 && tableNames.length === 0) {
      parts.push(`${objs[0].from} → ${objs[0].to} の線`);
    } else if (objs.length > 0) {
      parts.push(`${objs.length}本の線`);
    }
    setNotice(`${parts.join("と")}を削除しました`);
    persist(ents, fksRef.current, posRef.current, undefined, {
      removed,
      custom,
      anchors: nextAnchors,
      edgeCols: nextEdgeCols,
      edgeStyles: nextEdgeStyles,
      removedTables: removedT,
    });
  };
  const deleteEdgesByIdx = (idxs: number[]) => deleteSelection(idxs, []);
  /** 線の削除を確認してから実行する */
  const askDeleteEdges = (idxs: number[]) => {
    const objs = idxs.map((i) => edges[i]).filter(Boolean);
    if (objs.length === 0) return;
    setConfirm({
      title: "線を削除",
      message:
        objs.length === 1
          ? `${objs[0].from} → ${objs[0].to} の線を削除しますか？`
          : `選択中の${objs.length}本の線を削除しますか？`,
      action: () => deleteEdgesByIdx(idxs),
    });
  };

  /** テーブルの削除を確認してから実行する */
  const askDeleteTables = (names: string[]) => {
    if (names.length === 0) return;
    setConfirm({
      title: "テーブルを図から削除",
      message:
        (names.length === 1
          ? `${names[0]} を図から削除しますか？`
          : `選択中の${names.length}テーブルを図から削除しますか？`) +
        " (戻したい場合はリバース時に「削除したテーブルも復活させる」を選べます)",
      sub: "DBからは削除されません",
      action: () => removeTables(names),
    });
  };

  const deleteSelectedRef = useRef(() => {});
  deleteSelectedRef.current = () => {
    const edgeIdxs =
      selEdges.size > 0 ? [...selEdges] : selEdge !== null ? [selEdge] : [];
    const tableNames = [...selNodes];
    if (edgeIdxs.length === 0 && tableNames.length === 0) return;
    // 線とテーブルの両方が選択されていればまとめて削除する
    if (edgeIdxs.length > 0 && tableNames.length > 0) {
      setConfirm({
        title: "選択中の要素を削除",
        message: `${tableNames.length}テーブルと${edgeIdxs.length}本の線を削除しますか？ (テーブルはリバース時に「削除したテーブルも復活させる」で戻せます)`,
        sub: "DBからは削除されません",
        action: () => deleteSelection(edgeIdxs, tableNames),
      });
    } else if (edgeIdxs.length > 0) {
      askDeleteEdges(edgeIdxs);
    } else {
      askDeleteTables(tableNames);
    }
  };

  /** テーブルコピー用の内部クリップボード (タブ間の貼り付けに使う) */
  const tableClipRef = useRef<{
    entries: SchemaEntry[];
    positions: Record<string, { x: number; y: number }>;
    widths: Record<string, number>;
    fks: FkInfo[];
  } | null>(null);

  /** ⌘/Ctrl+C: 選択中のテーブルをコピー (無ければカラム行の内容をコピー) */
  const copySelectedRef = useRef(() => {});
  copySelectedRef.current = () => {
    // テーブル選択中はテーブルをコピー (⌘Vで別タブへ貼り付けられる)
    if (selNodes.size > 0 && entriesRef.current) {
      const ents = entriesRef.current.filter((e) =>
        selNodes.has(e.table.name)
      );
      const positions: Record<string, { x: number; y: number }> = {};
      const widths: Record<string, number> = {};
      for (const n of selNodes) {
        positions[n] = posOf(n);
        if (tableWidths[n] !== undefined) widths[n] = tableWidths[n];
      }
      tableClipRef.current = {
        entries: ents,
        positions,
        widths,
        fks: fksRef.current.filter(
          (f) => selNodes.has(f.table) && selNodes.has(f.refTable)
        ),
      };
      setNotice(
        `${ents.length}テーブルをコピーしました (⌘/Ctrl+Vで貼り付け)`
      );
      return;
    }
    if (!selCol || !entriesRef.current) return;
    const ent = entriesRef.current.find((x) => x.table.name === selCol.table);
    const col = ent?.detail.columns.find((c) => c.name === selCol.column);
    if (!col) return;
    const logical = parseComment(col.comment ?? "", delim)[0];
    const parts = [col.name];
    if (col.colType) parts.push(col.colType);
    if (logical) parts.push(logical);
    navigator.clipboard.writeText(parts.join("\t")).then(
      () => setNotice(`コピーしました: ${parts.join(" ")}`),
      () => {}
    );
  };

  /** ⌘/Ctrl+V: コピーしたテーブルを現在のタブへ貼り付ける */
  const pasteRef = useRef(() => {});
  pasteRef.current = () => {
    const clip = tableClipRef.current;
    if (!clip) return;
    const cur = entriesRef.current ?? [];
    const existing = new Set(cur.map((e) => e.table.name));
    const add = clip.entries.filter((e) => !existing.has(e.table.name));
    if (add.length === 0) {
      setNotice("コピーしたテーブルは全てこのタブに存在します");
      return;
    }
    const ents = [...cur, ...add];
    // 位置は元の座標から少しずらして貼り付ける
    for (const e of add) {
      const p = clip.positions[e.table.name] ?? { x: 40, y: 40 };
      posRef.current.set(e.table.name, { x: p.x + 24, y: p.y + 24 });
    }
    // 幅の上書きも引き継ぐ
    let widths = tableWidths;
    const wPicked: Record<string, number> = {};
    for (const e of add) {
      const w = clip.widths[e.table.name];
      if (w !== undefined) wPicked[e.table.name] = w;
    }
    if (Object.keys(wPicked).length > 0) {
      widths = { ...tableWidths, ...wPicked };
      setTableWidths(widths);
    }
    // コピー元のFKもマージする (重複は除外)
    const fkKeyOf = (f: FkInfo) =>
      `${f.table}.${f.column}->${f.refTable}.${f.refColumn}`;
    const have = new Set(fksRef.current.map(fkKeyOf));
    const fkList = [
      ...fksRef.current,
      ...clip.fks.filter((f) => !have.has(fkKeyOf(f))),
    ];
    setFks(fkList);
    setEntries(ents);
    // 削除済みテーブルとして記憶されていたら解除する
    let removed = removedTables;
    if (add.some((e) => removed.has(e.table.name))) {
      removed = new Set(removed);
      for (const e of add) removed.delete(e.table.name);
      setRemovedTables(removed);
    }
    setSelNodes(new Set(add.map((e) => e.table.name)));
    setSelEdge(null);
    setSelEdges(new Set());
    setRev((r) => r + 1);
    setNotice(`${add.length}テーブルを貼り付けました`);
    persist(ents, fkList, posRef.current, undefined, {
      removedTables: removed,
      tableWidths: widths,
    });
  };

  // Delete/Backspaceで選択中の線を削除、Escで選択・追加モードを解除
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Delete" || e.key === "Backspace") {
        deleteSelectedRef.current();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        copySelectedRef.current();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        pasteRef.current();
      } else if (e.key === "Escape") {
        setSelEdge(null);
        setSelEdges(new Set());
        setSelNodes(new Set());
        setSelCol(null);
        setLinkMode(false);
        setLinkSrc(null);
        setCtxMenu(null);
        setEdgePanel(null);
        setConfirm(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 表示設定プルダウンは外側をクリックしたら閉じる。
  // テーブル等はmousedownでstopPropagationするため、キャプチャ段階で検知する
  useEffect(() => {
    if (!optsOpen) return;
    const close = (e: MouseEvent) => {
      if (optsRef.current && !optsRef.current.contains(e.target as Node)) {
        setOptsOpen(false);
      }
    };
    document.addEventListener("mousedown", close, true);
    return () => document.removeEventListener("mousedown", close, true);
  }, [optsOpen]);

  // 図メニューも外側をクリックしたら閉じる
  useEffect(() => {
    if (!diagMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (
        diagMenuRef.current &&
        !diagMenuRef.current.contains(e.target as Node)
      ) {
        setDiagMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close, true);
    return () => document.removeEventListener("mousedown", close, true);
  }, [diagMenuOpen]);

  /** 表示オプションを切り替えて自動保存する */
  const toggleOpt = (k: "allCols" | "showLogical" | "showTypes") => {
    const cur = { allCols, showLogical, showTypes };
    const next = { ...cur, [k]: !cur[k] };
    setAllCols(next.allCols);
    setShowLogical(next.showLogical);
    setShowTypes(next.showTypes);
    if (entriesRef.current) {
      persist(entriesRef.current, fksRef.current, posRef.current, next);
    }
  };

  // 右クリックメニューは画面のどこかをクリックしたら閉じる
  // (メニュー内のクリックは除く。stopPropagation対策でキャプチャ段階で検知)
  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".context-menu")) return;
      setCtxMenu(null);
    };
    document.addEventListener("mousedown", close, true);
    return () => document.removeEventListener("mousedown", close, true);
  }, [ctxMenu]);

  // 線の編集パネルは外側をクリックしたら閉じる
  useEffect(() => {
    if (!edgePanel) return;
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".er-edge-panel")) return;
      setEdgePanel(null);
    };
    document.addEventListener("mousedown", close, true);
    return () => document.removeEventListener("mousedown", close, true);
  }, [edgePanel]);

  /** 線の編集パネルを開く (画面外にはみ出さない位置に調整) */
  const openEdgePanel = (edgeIdx: number, cx: number, cy: number) => {
    setSelEdge(edgeIdx);
    setSelEdges(new Set([edgeIdx]));
    setEdgePanel({
      edge: edgeIdx,
      x: Math.max(8, Math.min(cx, window.innerWidth - 428)),
      y: Math.max(8, Math.min(cy, window.innerHeight - 380)),
    });
  };

  /** カラムをクリックしたときの処理。
   * 通常時は行を選択 (再クリックで解除)、線の追加モード中は接続先の指定 */
  const handleColumnClick = (table: string, column: string) => {
    if (!linkMode) {
      setSelNodes(new Set());
      setSelCol((cur) =>
        cur && cur.table === table && cur.column === column
          ? null
          : { table, column }
      );
      return;
    }
    if (!linkSrc) {
      setLinkSrc({ table, column });
      setNotice(`接続元: ${table}.${column} — 接続先のカラムをクリック`);
      return;
    }
    if (linkSrc.table === table) {
      setNotice("別のテーブルのカラムを選択してください");
      return;
    }
    const c: ErCustomEdge = {
      from: linkSrc.table,
      fromColumn: linkSrc.column,
      to: table,
      toColumn: column,
    };
    const custom = [...customEdges, c];
    setCustomEdges(custom);
    setLinkMode(false);
    setLinkSrc(null);
    setNotice(`${c.from}.${c.fromColumn} → ${c.to}.${c.toColumn} を追加しました`);
    if (entriesRef.current) {
      persist(entriesRef.current, fksRef.current, posRef.current, undefined, {
        custom,
      });
    }
  };

  /** 枠の一覧を更新して自動保存する */
  const updateFrames = (next: ErFrame[]) => {
    setFrames(next);
    if (entriesRef.current) {
      persist(entriesRef.current, fksRef.current, posRef.current, undefined, {
        frames: next,
      });
    }
  };

  /** 枠/テキストのインライン編集を開始する */
  const startEditing = (f: ErFrame) => {
    setEditingId(f.id);
    setEditText(f.label);
  };

  /** インライン編集を確定する */
  const commitEdit = () => {
    if (editingId === null) return;
    updateFrames(
      frames.map((x) => (x.id === editingId ? { ...x, label: editText } : x))
    );
    setEditingId(null);
  };
  const commitEditRef = useRef(() => {});
  commitEditRef.current = commitEdit;

  // 編集中に入力欄の外をクリックしたら編集を確定して終了する。
  // (キャンバス側はmousedownでpreventDefaultするためblurが飛ばないケースがある)
  useEffect(() => {
    if (editingId === null) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".er-text-edit, .er-inline-input")) return;
      commitEditRef.current();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [editingId]);

  /** 枠を追加してテキスト編集ダイアログを開く */
  const addFrame = (worldX: number, worldY: number) => {
    const f: ErFrame = {
      id: `f${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      kind: "box",
      label: "グループ",
      style: "dashed",
      x: worldX,
      y: worldY,
      w: 340,
      h: 240,
    };
    updateFrames([...frames, f]);
    startEditing(f);
  };

  /** テキスト見出しを追加してテキスト編集ダイアログを開く */
  const addText = (worldX: number, worldY: number) => {
    const f: ErFrame = {
      id: `t${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      kind: "text",
      label: "テキスト",
      style: "none",
      fontSize: 18,
      x: worldX,
      y: worldY,
      w: 200,
      h: 40,
    };
    updateFrames([...frames, f]);
    startEditing(f);
  };

  /** 枠のドラッグ移動 (ラベル部分をつかむ) */
  const startFrameDrag = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const f = frames.find((x) => x.id === id);
    if (!f) return;
    const start = { x: e.clientX, y: e.clientY };
    const orig = { x: f.x, y: f.y };
    let latest = frames;
    const move = (ev: MouseEvent) => {
      latest = frames.map((x) =>
        x.id === id
          ? {
              ...x,
              x: orig.x + (ev.clientX - start.x) / view.scale,
              y: orig.y + (ev.clientY - start.y) / view.scale,
            }
          : x
      );
      setFrames(latest);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      if (entriesRef.current) {
        persist(entriesRef.current, fksRef.current, posRef.current, undefined, {
          frames: latest,
        });
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** 枠のリサイズ (右下ハンドル) */
  const startFrameResize = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const f = frames.find((x) => x.id === id);
    if (!f) return;
    const start = { x: e.clientX, y: e.clientY };
    const orig = { w: f.w, h: f.h };
    let latest = frames;
    const move = (ev: MouseEvent) => {
      latest = frames.map((x) =>
        x.id === id
          ? {
              ...x,
              w: Math.max(120, orig.w + (ev.clientX - start.x) / view.scale),
              h: Math.max(80, orig.h + (ev.clientY - start.y) / view.scale),
            }
          : x
      );
      setFrames(latest);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      if (entriesRef.current) {
        persist(entriesRef.current, fksRef.current, posRef.current, undefined, {
          frames: latest,
        });
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** 線の端点ドラッグ: テーブル境界上を自由に動かして接続位置を変える。
   * カーソルに最も近い辺へ吸着し、左右の辺ではカラム行にも吸着する */
  const startAnchorDrag = (
    e: React.MouseEvent,
    edgeIdx: number,
    which: "from" | "to"
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const edge = edges[edgeIdx];
    const el = canvasRef.current;
    if (!edge || !el) return;
    const table = which === "from" ? edge.from : edge.to;
    const node = nodeByName.get(table);
    if (!node) return;
    const key = edgeKey(edge);
    let latest = anchors;
    const move = (ev: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const wx = (ev.clientX - rect.left - view.x) / view.scale;
      const wy = (ev.clientY - rect.top - view.y) / view.scale;
      const a = nearestBorderAnchor(node, posOf(table), wx, wy);
      latest = { ...anchors, [key]: { ...anchors[key], [which]: a } };
      setAnchors(latest);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      if (entriesRef.current) {
        persist(entriesRef.current, fksRef.current, posRef.current, undefined, {
          anchors: latest,
        });
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** 線の見た目 (線種・色) を変更する。既定値 (破線・既定色) に戻ったら設定を消す */
  const setEdgeStyle = (edgeIdx: number, patch: Partial<ErEdgeStyle>) => {
    const edge = edges[edgeIdx];
    if (!edge) return;
    const key = edgeKey(edge);
    const entry: ErEdgeStyle = { ...edgeStyles[key], ...patch };
    if (entry.style === "dashed") delete entry.style;
    if (!entry.color) delete entry.color;
    const next = { ...edgeStyles };
    if (!entry.style && !entry.color) delete next[key];
    else next[key] = entry;
    setEdgeStyles(next);
    if (entriesRef.current) {
      persist(entriesRef.current, fksRef.current, posRef.current, undefined, {
        edgeStyles: next,
      });
    }
  };

  /** 選択中の線の対応カラムを追加/解除する (複合キーなど複数カラムの対応用)。
   * 対応カラムは線を選択したときにハイライトされる */
  const toggleEdgeColumn = (
    edgeIdx: number,
    side: "from" | "to",
    column: string
  ) => {
    const edge = edges[edgeIdx];
    if (!edge) return;
    const key = edgeKey(edge);
    const cur = edgeCols[key] ?? { from: [], to: [] };
    const list = cur[side];
    const entry = {
      ...cur,
      [side]: list.includes(column)
        ? list.filter((c) => c !== column)
        : [...list, column],
    };
    const next = { ...edgeCols };
    if (entry.from.length === 0 && entry.to.length === 0) delete next[key];
    else next[key] = entry;
    setEdgeCols(next);
    if (entriesRef.current) {
      persist(entriesRef.current, fksRef.current, posRef.current, undefined, {
        edgeCols: next,
      });
    }
  };

  /** 線の接続位置指定を解除して自動 (カラム横) に戻す */
  const resetAnchors = (edgeIdx: number) => {
    const edge = edges[edgeIdx];
    if (!edge) return;
    const key = edgeKey(edge);
    if (!anchors[key]) return;
    const next = { ...anchors };
    delete next[key];
    setAnchors(next);
    if (entriesRef.current) {
      persist(entriesRef.current, fksRef.current, posRef.current, undefined, {
        anchors: next,
      });
    }
  };

  /** キャンバス中央を基準に拡大/縮小する (右下のズームボタン用) */
  const zoomBy = (factor: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = rect.width / 2;
    const my = rect.height / 2;
    setView((v) => {
      const scale = Math.min(2.5, Math.max(0.12, v.scale * factor));
      return {
        scale,
        x: mx - ((mx - v.x) * scale) / v.scale,
        y: my - ((my - v.y) * scale) / v.scale,
      };
    });
  };

  /** Shift+背景ドラッグで矩形選択 (テーブル・線の複数選択) */
  const startBand = (e: React.MouseEvent) => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const toWorld = (cx: number, cy: number) => ({
      x: (cx - rect.left - view.x) / view.scale,
      y: (cy - rect.top - view.y) / view.scale,
    });
    const p0 = toWorld(e.clientX, e.clientY);
    setBand({ x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y });
    const move = (ev: MouseEvent) => {
      const p = toWorld(ev.clientX, ev.clientY);
      setBand({ x0: p0.x, y0: p0.y, x1: p.x, y1: p.y });
    };
    const up = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", move);
      const p = toWorld(ev.clientX, ev.clientY);
      const minX = Math.min(p0.x, p.x);
      const maxX = Math.max(p0.x, p.x);
      const minY = Math.min(p0.y, p.y);
      const maxY = Math.max(p0.y, p.y);
      // 矩形にかかったテーブルを選択
      const selN = new Set<string>();
      for (const n of nodes) {
        const q = posOf(n.name);
        if (
          q.x < maxX &&
          q.x + n.w > minX &&
          q.y < maxY &&
          q.y + n.h > minY
        ) {
          selN.add(n.name);
        }
      }
      // 矩形にかかった線を選択 (一部でも重なればOK。線分は全て直交なので
      // 各線分のバウンディングボックスと矩形の重なりで判定できる)
      const selE = new Set<number>();
      edgeGeoms.forEach((pts, i) => {
        if (!pts) return;
        for (let k = 1; k < pts.length; k++) {
          const sx0 = Math.min(pts[k - 1][0], pts[k][0]);
          const sx1 = Math.max(pts[k - 1][0], pts[k][0]);
          const sy0 = Math.min(pts[k - 1][1], pts[k][1]);
          const sy1 = Math.max(pts[k - 1][1], pts[k][1]);
          if (sx0 <= maxX && sx1 >= minX && sy0 <= maxY && sy1 >= minY) {
            selE.add(i);
            break;
          }
        }
      });
      setSelNodes(selN);
      setSelEdges(selE);
      setSelEdge(null);
      setBand(null);
      if (selN.size + selE.size > 0) {
        setNotice(
          `${selN.size}テーブル / ${selE.size}本の線を選択しました (Deleteで削除)`
        );
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** 背景ドラッグで範囲選択 (Shift+ドラッグ・中ボタンドラッグはパン) */
  const startPan = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.button === 2) return;
    // 背景クリックでリレーション・テーブル・カラム行の選択を解除する
    setSelEdge(null);
    setSelEdges(new Set());
    setSelNodes(new Set());
    setSelCol(null);
    e.preventDefault();
    if (e.button === 0 && !e.shiftKey) {
      startBand(e);
      return;
    }
    const start = { x: e.clientX, y: e.clientY };
    const orig = { ...view };
    const move = (ev: MouseEvent) => {
      setView({
        ...orig,
        x: orig.x + (ev.clientX - start.x),
        y: orig.y + (ev.clientY - start.y),
      });
    };
    const up = () => document.removeEventListener("mousemove", move);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** コンテンツ全体のバウンディングボックス */
  const bounds = useMemo(() => {
    let maxX = 400;
    let maxY = 300;
    for (const n of nodes) {
      const p = posOf(n.name);
      maxX = Math.max(maxX, p.x + n.w);
      maxY = Math.max(maxY, p.y + n.h);
    }
    for (const f of frames) {
      maxX = Math.max(maxX, f.x + f.w);
      maxY = Math.max(maxY, f.y + f.h);
    }
    return { w: maxX + 60, h: maxY + 60 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, rev, frames]);

  const nodeByName = useMemo(
    () => new Map(nodes.map((n) => [n.name, n])),
    [nodes]
  );

  /** 各エッジの折れ線経路 (画面描画・PNG出力・交差判定で共用)。
   * 位置はrefで持っているためメモ化せず毎レンダー計算する */
  const edgeGeoms: ([number, number][] | null)[] = edges.map((e) => {
    const a = nodeByName.get(e.from);
    const b = nodeByName.get(e.to);
    if (!a || !b) return null;
    const pa = posOf(e.from);
    const pb = posOf(e.to);
    // 両端のテーブル矩形 (線がこの後ろに隠れないように迂回する)
    const rects: Rect[] = [
      { x: pa.x, y: pa.y, w: a.w, h: a.h },
      { x: pb.x, y: pb.y, w: b.w, h: b.h },
    ];
    const ov = anchors[edgeKey(e)];
    let fromPt: AnchoredPt;
    let toPt: AnchoredPt;
    if (ov?.from || ov?.to) {
      // 接続位置が手動指定されている線: 指定の辺から出す
      const toPre = ov.to ? anchorPointPos(b, pb, ov.to) : null;
      fromPt = ov.from
        ? anchorPointPos(a, pa, ov.from)
        : colSideAnchor(a, pa, e.fromColumn, toPre?.x ?? pb.x + b.w / 2);
      toPt = toPre ?? colSideAnchor(b, pb, e.toColumn, fromPt.x);
    } else {
      // 既定 (カラム横)。従来の経路がテーブルに隠れなければそのまま使う
      const ay = anchorY(a, pa.y, e.fromColumn);
      const by = anchorY(b, pb.y, e.toColumn);
      const pts = edgePoints(
        { x: pa.x, w: a.w },
        ay,
        { x: pb.x, w: b.w },
        by
      );
      if (pathClear(pts, rects)) return pts;
      fromPt = colSideAnchor(a, pa, e.fromColumn, pb.x + b.w / 2);
      toPt = colSideAnchor(b, pb, e.toColumn, pa.x + a.w / 2);
    }
    // 単純経路がテーブルにかからなければ採用、かかるなら迂回経路を探す
    const simple = routeAnchored(fromPt, toPt);
    if (pathClear(simple, rects)) return simple;
    return routeAvoid(fromPt, toPt, rects) ?? simple;
  });
  /** 全エッジの垂直区間 (エッジごと)。自分以外との交差判定に使う */
  const allVerticals = edgeGeoms.map((p) => (p ? verticalSegments(p) : []));
  const verticalsExcept = (i: number) =>
    allVerticals.flatMap((segs, j) => (j === i ? [] : segs));

  /** PNG出力 (現在の配置をcanvasに描き直して保存) */
  const exportPng = async () => {
    if (nodes.length === 0) return;
    try {
      setNotice("PNG生成中...");
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
      // 現在のカラーモードに合わせた配色 (ライトはライトのまま出力する)
      const isLight = document.documentElement.dataset.theme === "light";
      const pal = isLight
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
      ctx.fillText(`Quelio ER図 — ${sel.database}`, 20, 18);
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
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const d = new Date();
      const p2 = (v: number) => String(v).padStart(2, "0");
      const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const path = await saveCapture(`quelio_er_${sel.database}_${ts}.png`, base64);
      setNotice(`保存しました → ${path}`);
    } catch (e) {
      setNotice(`PNG保存に失敗: ${e}`);
    }
  };

  /** 注釈枠 (box) 1個の描画 */
  const renderBox = (f: ErFrame) => (
    <div
      key={f.id}
      className={
        "er-frame " + f.style + (f.rounded === false ? " square" : "")
      }
      style={{
        left: f.x,
        top: f.y,
        width: f.w,
        height: f.h,
        borderColor:
          f.style !== "none" && f.color ? hexAlpha(f.color, 0.75) : undefined,
        background: f.fill ? hexAlpha(f.fill, FILL_ALPHA) : undefined,
      }}
    >
      <div
        className="er-frame-label"
        title="ドラッグで移動 / ダブルクリックで編集 / 右クリックでメニュー"
        onMouseDown={(e) => {
          if (f.id === editingId) return;
          startFrameDrag(e, f.id);
        }}
        onDoubleClick={() => startEditing(f)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({
            x: e.clientX,
            y: e.clientY,
            kind: "frame",
            frameId: f.id,
          });
        }}
      >
        {f.id === editingId ? (
          <input
            className="er-inline-input"
            value={editText}
            autoFocus
            onChange={(e) => setEditText(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              else if (e.key === "Escape") setEditingId(null);
            }}
            onBlur={commitEdit}
          />
        ) : (
          f.label
        )}
      </div>
      <div
        className="er-frame-resize"
        title="ドラッグでサイズ変更"
        onMouseDown={(e) => startFrameResize(e, f.id)}
      />
    </div>
  );

  /** テキスト見出し1個の描画 (編集中はその場で入力欄になる) */
  const renderText = (f: ErFrame) => {
    const size = f.fontSize ?? 18;
    if (f.id === editingId) {
      return (
        <input
          key={f.id}
          className="er-text er-text-edit"
          style={{
            left: f.x,
            top: f.y,
            fontSize: size,
            color: f.textColor || undefined,
            width: Math.max(80, charUnits(editText) * size * 0.55 + 40),
          }}
          value={editText}
          autoFocus
          onChange={(e) => setEditText(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            else if (e.key === "Escape") setEditingId(null);
          }}
          onBlur={commitEdit}
        />
      );
    }
    return (
      <div
        key={f.id}
        className="er-text"
        style={{
          left: f.x,
          top: f.y,
          fontSize: size,
          color: f.textColor || undefined,
        }}
        title="ドラッグで移動 / ダブルクリックで編集 / 右クリックでメニュー"
        onMouseDown={(e) => startFrameDrag(e, f.id)}
        onDoubleClick={() => startEditing(f)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({
            x: e.clientX,
            y: e.clientY,
            kind: "frame",
            frameId: f.id,
          });
        }}
      >
        {f.label}
      </div>
    );
  };

  const backBoxes = frames.filter((f) => f.kind !== "text" && !f.front);
  const frontBoxes = frames.filter((f) => f.kind !== "text" && f.front);
  const texts = frames.filter((f) => f.kind === "text");

  return (
    <div className="er-window">
      <div className="diff-toolbar" data-tauri-drag-region>
        <div className="er-opts" ref={diagMenuRef}>
          <button
            className="btn-secondary er-diag-btn"
            title={diagName ?? "未保存の図"}
            onClick={() => setDiagMenuOpen((o) => !o)}
          >
            <span className="er-diag-name">{diagName ?? "(未保存の図)"}</span>{" "}
            <span className="er-opts-caret">▾</span>
          </button>
          {diagMenuOpen && (
            <div className="er-opts-pop er-diag-pop">
              {diagList.length > 0 ? (
                diagList.map((name) => (
                  <button
                    key={name}
                    className={
                      "context-item" + (name === diagName ? " checked" : "")
                    }
                    onClick={() => {
                      openDiagram(name);
                      setDiagMenuOpen(false);
                    }}
                  >
                    {name === diagName ? "✓ " : "　 "}
                    {name}
                  </button>
                ))
              ) : (
                <div className="context-caption">保存済みの図はありません</div>
              )}
              <div className="context-sep" />
              <button
                className="context-item"
                onClick={() => {
                  clearDiagram();
                  setNotice(
                    "新しい図です。「リバース」でDBから読み込んでください"
                  );
                  setDiagMenuOpen(false);
                }}
              >
                新しい図
              </button>
              <button
                className="context-item"
                disabled={!entries}
                onClick={() => {
                  setNameDialog({
                    mode: "saveAs",
                    value:
                      diagName ??
                      `${session?.name ?? "ER図"}/${sel.database}`,
                  });
                  setDiagMenuOpen(false);
                }}
              >
                名前を付けて保存...
              </button>
              {diagName && (
                <button
                  className="context-item"
                  onClick={() => {
                    setNameDialog({ mode: "rename", value: diagName });
                    setDiagMenuOpen(false);
                  }}
                >
                  名前を変更...
                </button>
              )}
              {diagName && (
                <button
                  className="context-item danger"
                  onClick={() => {
                    deleteCurrentDiagram();
                    setDiagMenuOpen(false);
                  }}
                >
                  この図を削除
                </button>
              )}
            </div>
          )}
        </div>
        <div className="diff-side-sel">
          <SelectMenu
            className="mono"
            value={sel.sessionId}
            placeholder="接続を選択"
            options={sessions.map((s) => ({
              value: s.sessionId,
              label: s.name,
            }))}
            onChange={(v) => {
              const s = sessions.find((x) => x.sessionId === v);
              const db = s?.currentDb ?? s?.databases[0] ?? "";
              setSel({ sessionId: v, database: db });
            }}
          />
          <SelectMenu
            className="mono"
            value={sel.database}
            disabled={!session}
            options={(session?.databases ?? [sel.database]).map((d) => ({
              value: d,
              label: d,
            }))}
            onChange={(v) => setSel({ ...sel, database: v })}
          />
        </div>
        <button
          className="btn-primary has-tooltip tooltip-left tooltip-wrap"
          data-tooltip={
            "DBからスキーマを読み込んでER図を作成/更新します\n(既存の配置は維持されます)"
          }
          disabled={loading || !sel.sessionId}
          onClick={() => doReverse()}
        >
          {loading ? (
            <>
              <span className="spinner light" /> リバース中...
            </>
          ) : (
            "リバース"
          )}
        </button>
        <div className="er-opts" ref={optsRef}>
          <button
            className="btn-secondary"
            onClick={() => setOptsOpen((o) => !o)}
          >
            表示設定 <span className="er-opts-caret">▾</span>
          </button>
          {optsOpen && (
            <div className="er-opts-pop">
              {(
                [
                  ["allCols", "全カラム", allCols],
                  ["showLogical", "日本語名", showLogical],
                  ["showTypes", "型・サイズ", showTypes],
                ] as const
              ).map(([key, label, on]) => (
                <button
                  key={key}
                  className={"context-item" + (on ? " checked" : "")}
                  onClick={() => toggleOpt(key)}
                >
                  {on ? "✓ " : "　 "}
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          className="btn-secondary"
          disabled={nodes.length === 0}
          onClick={exportPng}
        >
          PNG保存
        </button>
        <span className="er-meta mono">
          {entries
            ? `${nodes.length}テーブル / ${edges.length}リレーション`
            : ""}
        </span>
      </div>

      {/* ページ (タブ) バー: 1つの保存ファイルに複数のER図を持てる */}
      <div className="er-tabs">
        {pages.map((p, i) => (
          <div
            key={p.id}
            className={"er-tab" + (p.id === pageId ? " active" : "")}
            title="クリックで切替 / ダブルクリックで名前変更 / ドラッグで並べ替え"
            onMouseDown={(e) => {
              if (e.button !== 0 || tabEditingId === p.id) return;
              dragTabIdxRef.current = i;
              if (p.id !== pageId) switchPage(p.id);
            }}
            onMouseEnter={() => {
              const from = dragTabIdxRef.current;
              if (from === null || from === i) return;
              reorderPages(from, i);
              dragTabIdxRef.current = i;
            }}
            onDoubleClick={() => {
              setTabEditingId(p.id);
              setTabEditText(p.name);
            }}
          >
            {tabEditingId === p.id ? (
              <input
                className="er-tab-input"
                value={tabEditText}
                autoFocus
                onChange={(e) => setTabEditText(e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTabRename();
                  else if (e.key === "Escape") setTabEditingId(null);
                }}
                onBlur={commitTabRename}
              />
            ) : (
              <>
                <span className="er-tab-name">{p.name}</span>
                {pages.length > 1 && (
                  <span
                    className="er-tab-close"
                    title="タブを削除"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => deletePage(p.id)}
                  >
                    ×
                  </span>
                )}
              </>
            )}
          </div>
        ))}
        <button className="er-tab-add" title="タブを追加" onClick={addPage}>
          ＋
        </button>
      </div>

      {/* 右上の通知トースト (5秒で自動的に消える) */}
      {notice && (
        <div className="er-toast" key={notice}>
          <span className="er-toast-icon">✓</span>
          {notice}
        </div>
      )}

      {error && <div className="result-banner ng er-error">{error}</div>}
      {loading && (
        <div className="content-placeholder dim-center">
          <span className="spinner accent" /> スキーマを読み込み中...
        </div>
      )}
      {!loading && !error && !entries && (
        <div className="content-placeholder dim-center">
          {sel.sessionId
            ? "図は空です。「リバース」でDBから作成するか、図メニューから保存済みの図を開いてください"
            : "接続とデータベースを選択してください"}
        </div>
      )}

      {!loading && entries && (
        <div
          className={"er-canvas" + (linkMode ? " link-mode" : "")}
          ref={canvasRef}
          onMouseDownCapture={() => {
            // 検索窓にフォーカスが残っているとDeleteキー等が検索欄に
            // 取られるため、キャンバス操作を始めたらフォーカスを外す
            const ae = document.activeElement as HTMLElement | null;
            if (ae && ae.closest(".find-bar")) ae.blur();
          }}
          onMouseDown={startPan}
          onContextMenu={(e) => {
            // 背景の右クリック → 枠の追加メニュー
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            setCtxMenu({
              x: e.clientX,
              y: e.clientY,
              kind: "canvas",
              worldX: (e.clientX - rect.left - view.x) / view.scale,
              worldY: (e.clientY - rect.top - view.y) / view.scale,
            });
          }}
        >
          <div
            className="er-content"
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
            {/* 注釈枠 (背面) */}
            {backBoxes.map(renderBox)}
            <svg
              className={
                "er-edges" +
                (selEdge !== null || selEdges.size > 0 ? " has-sel" : "")
              }
              width={bounds.w}
              height={bounds.h}
              data-rev={rev}
            >
              {[...edges.keys()]
                // 選択中のエッジを最後に描いて最前面に出す
                .sort(
                  (x, y) => (x === selEdge ? 1 : 0) - (y === selEdge ? 1 : 0)
                )
                .map((i) => {
                  const e = edges[i];
                  const pts = edgeGeoms[i];
                  if (!pts) return null;
                  const ptsStr = pts.map((p) => p.join(",")).join(" ");
                  const first = pts[0];
                  const last = pts[pts.length - 1];
                  // 線種・色の上書き (選択中の色はハイライトを優先)
                  const isSel = i === selEdge || selEdges.has(i);
                  const es = edgeStyles[edgeKey(e)];
                  const dash =
                    es?.style === "solid"
                      ? "none"
                      : es?.style === "dotted"
                        ? "2 4"
                        : undefined;
                  const strokeColor = isSel
                    ? undefined
                    : es?.color || undefined;
                  return (
                    <g
                      key={i}
                      className={
                        "er-edge" +
                        (e.guessed ? " guessed" : "") +
                        (e.manual ? " manual" : "") +
                        (isSel ? " selected" : "")
                      }
                    >
                      <path
                        d={edgePath(pts, verticalsExcept(i))}
                        style={{
                          stroke: strokeColor,
                          strokeDasharray: dash,
                        }}
                      />
                      <circle
                        cx={first[0]}
                        cy={first[1]}
                        r={2.5}
                        style={{ fill: strokeColor }}
                      />
                      <circle
                        cx={last[0]}
                        cy={last[1]}
                        r={2.5}
                        style={{ fill: strokeColor }}
                      />
                      {/* クリック判定用の透明な太線 */}
                      <polyline
                        className="er-edge-hit"
                        points={ptsStr}
                        onMouseDown={(ev) => ev.stopPropagation()}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          const next = i === selEdge ? null : i;
                          setSelEdge(next);
                          setSelEdges(
                            next === null ? new Set() : new Set([next])
                          );
                          setSelNodes(new Set());
                        }}
                        onDoubleClick={(ev) => {
                          ev.stopPropagation();
                          openEdgePanel(i, ev.clientX, ev.clientY);
                        }}
                        onContextMenu={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          setSelEdge(i);
                          setSelEdges(new Set([i]));
                          setCtxMenu({
                            x: ev.clientX,
                            y: ev.clientY,
                            kind: "edge",
                            edge: i,
                          });
                        }}
                      />
                      {i === selEdge && (
                        <>
                          <circle
                            className="er-edge-handle"
                            cx={first[0]}
                            cy={first[1]}
                            r={5.5}
                            onMouseDown={(ev) => startAnchorDrag(ev, i, "from")}
                          >
                            <title>ドラッグで接続位置を変更 ({e.from})</title>
                          </circle>
                          <circle
                            className="er-edge-handle"
                            cx={last[0]}
                            cy={last[1]}
                            r={5.5}
                            onMouseDown={(ev) => startAnchorDrag(ev, i, "to")}
                          >
                            <title>ドラッグで接続位置を変更 ({e.to})</title>
                          </circle>
                        </>
                      )}
                      <title>{`${e.from} → ${e.to} (${e.label})${e.guessed ? " [推測]" : ""}`}</title>
                    </g>
                  );
                })}
              {/* ドラッグ接続中のプレビュー線 */}
              {linkDrag &&
                (() => {
                  const n = nodeByName.get(linkDrag.from.table);
                  if (!n) return null;
                  const src = colSideAnchor(
                    n,
                    posOf(linkDrag.from.table),
                    linkDrag.from.column,
                    linkDrag.x
                  );
                  return (
                    <path
                      className="er-link-preview"
                      d={`M ${src.x} ${src.y} L ${linkDrag.x} ${linkDrag.y}`}
                    />
                  );
                })()}
            </svg>
            {nodes.map((n) => {
              const p = posOf(n.name);
              const sel = selEdge !== null ? edges[selEdge] : null;
              const related =
                sel !== null && (sel.from === n.name || sel.to === n.name);
              /** 選択中リレーションの接続カラム名 (このノードに関係するもの)。
               * 代表カラムに加えて、手動追加した対応カラムもハイライトする */
              const hlCols = new Set<string>();
              const selCols = sel ? edgeCols[edgeKey(sel)] : undefined;
              if (sel && sel.from === n.name) {
                hlCols.add(sel.fromColumn);
                for (const c of selCols?.from ?? []) hlCols.add(c);
              }
              if (sel && sel.to === n.name) {
                hlCols.add(sel.toColumn);
                for (const c of selCols?.to ?? []) hlCols.add(c);
              }
              // 線の追加モードで選択済みの接続元カラムもハイライト
              if (linkSrc && linkSrc.table === n.name) hlCols.add(linkSrc.column);
              // ドラッグ接続中の接続元・接続先候補もハイライト
              if (linkDrag?.from.table === n.name) {
                hlCols.add(linkDrag.from.column);
              }
              if (linkDrag?.target && linkDrag.target.table === n.name) {
                hlCols.add(linkDrag.target.column);
              }
              /** クリックで選択中のカラム行 (このノード内のもの) */
              const rowSel =
                selCol && selCol.table === n.name ? selCol.column : null;
              const rowSelIdx = rowSel
                ? n.columns.findIndex((c) => c.name === rowSel)
                : -1;
              return (
                <div
                  key={n.name}
                  className={
                    "er-node" +
                    (related ? " related" : "") +
                    (selNodes.has(n.name) ? " selected" : "")
                  }
                  style={{ left: p.x, top: p.y, width: n.w, height: n.h }}
                  onMouseDown={(e) => startNodeDrag(e, n.name)}
                  onMouseLeave={() =>
                    setHoverCol((h) => (h?.table === n.name ? null : h))
                  }
                >
                  <div
                    className="er-node-head mono"
                    title={n.logical ? `${n.name} (${n.logical})` : n.name}
                    onMouseDown={(e) => startNodeDrag(e, n.name)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setSelNodes((prev) =>
                        prev.has(n.name) ? prev : new Set([n.name])
                      );
                      setCtxMenu({
                        x: e.clientX,
                        y: e.clientY,
                        kind: "node",
                        table: n.name,
                      });
                    }}
                  >
                    {n.name}
                    {n.logical && (
                      <span className="er-node-head-logical">{n.logical}</span>
                    )}
                  </div>
                  {rowSelIdx >= 0 && (
                    <div
                      className="er-row-sel"
                      style={{ top: NODE_HEAD_H + rowSelIdx * ROW_H }}
                    />
                  )}
                  <div
                    className="er-node-cols mono"
                    style={{
                      gridTemplateColumns:
                        "max-content" +
                        (showTypes ? " max-content" : "") +
                        (showLogical ? " max-content" : ""),
                    }}
                  >
                    {n.columns.map((c, i) => (
                      <Fragment key={i}>
                        <span
                          className={
                            "er-col-name" +
                            (c.isPk ? " pk" : "") +
                            (hlCols.has(c.name) ? " hl" : "") +
                            (rowSel === c.name ? " sel" : "")
                          }
                          title={
                            c.name +
                            (c.isPk
                              ? " (主キー)"
                              : c.notNull
                                ? " (NOT NULL)"
                                : " (NULL可)")
                          }
                          onClick={() => handleColumnClick(n.name, c.name)}
                          onMouseEnter={() =>
                            setHoverCol({
                              table: n.name,
                              column: c.name,
                              idx: i,
                            })
                          }
                          onContextMenu={(ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            setCtxMenu({
                              x: ev.clientX,
                              y: ev.clientY,
                              kind: "column",
                              table: n.name,
                              column: c.name,
                            });
                          }}
                        >
                          {colMarker(c)}
                          {c.name}
                        </span>
                        {showTypes && (
                          <span
                            className={
                              "er-col-type" +
                              (rowSel === c.name ? " sel" : "")
                            }
                            title={c.type}
                            onClick={() => handleColumnClick(n.name, c.name)}
                            onMouseEnter={() =>
                              setHoverCol({
                                table: n.name,
                                column: c.name,
                                idx: i,
                              })
                            }
                          >
                            {c.type}
                          </span>
                        )}
                        {showLogical && (
                          <span
                            className={
                              "er-col-logical" +
                              (rowSel === c.name ? " sel" : "")
                            }
                            title={c.logical}
                            onClick={() => handleColumnClick(n.name, c.name)}
                            onMouseEnter={() =>
                              setHoverCol({
                                table: n.name,
                                column: c.name,
                                idx: i,
                              })
                            }
                          >
                            {c.logical}
                          </span>
                        )}
                      </Fragment>
                    ))}
                  </div>
                  <div
                    className="er-node-resize"
                    title="ドラッグで幅を調整 (右クリックメニューで自動に戻せます)"
                    onMouseDown={(e) => startNodeResize(e, n.name)}
                  />
                  {/* ホバー中のカラム行の両端に出る接続ハンドル */}
                  {hoverCol?.table === n.name && !linkDrag && (
                    <>
                      {(["left", "right"] as const).map((side) => (
                        <div
                          key={side}
                          className={`er-link-handle ${side}`}
                          style={{
                            top:
                              NODE_HEAD_H +
                              hoverCol.idx * ROW_H +
                              ROW_H / 2 -
                              5.5,
                          }}
                          title="ドラッグして相手のカラムへ線をつなぐ"
                          onMouseDown={(e) =>
                            startLinkDrag(e, n.name, hoverCol.column)
                          }
                        />
                      ))}
                    </>
                  )}
                </div>
              );
            })}
            {/* 注釈枠 (前面) とテキスト見出し */}
            {frontBoxes.map(renderBox)}
            {texts.map(renderText)}
            {/* Shift+ドラッグの矩形選択 */}
            {band && (
              <div
                className="er-band"
                style={{
                  left: Math.min(band.x0, band.x1),
                  top: Math.min(band.y0, band.y1),
                  width: Math.abs(band.x1 - band.x0),
                  height: Math.abs(band.y1 - band.y0),
                }}
              />
            )}
          </div>
          <div className="er-legend mono">
            ● = NOT NULL / ○ = NULL可 (色付き● = 主キー) ・
            線の右クリックで削除 / カラムの右クリックで線を追加 /
            線を選択して端点をドラッグで接続位置を変更 ・
            背景ドラッグで範囲選択 / スクロール・Shift+ドラッグでパン /
            ⌘(Ctrl)+スクロール・ピンチでズーム
          </div>
          <div
            className="er-zoom-controls"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button title="拡大" onClick={() => zoomBy(1.25)}>
              ＋
            </button>
            <button
              className="zoom-pct mono"
              title="100%に戻す"
              onClick={() => zoomBy(1 / view.scale)}
            >
              {Math.round(view.scale * 100)}%
            </button>
            <button title="縮小" onClick={() => zoomBy(1 / 1.25)}>
              −
            </button>
            <button
              className="fit"
              title="全体を画面に収める"
              onClick={() => setFitTick((t) => t + 1)}
            >
              Fit
            </button>
          </div>
        </div>
      )}

      {/* 右クリックメニュー (線の削除 / 線の追加) */}
      {ctxMenu && (
        <div
          className="context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {ctxMenu.kind === "edge" ? (
            (() => {
              const edge = edges[ctxMenu.edge];
              if (!edge) return null;
              const ek = edgeKey(edge);
              const es = edgeStyles[ek];
              const curStyle = es?.style ?? "dashed";
              return (
                <>
                  <button
                    className="context-item"
                    onClick={() => {
                      openEdgePanel(ctxMenu.edge, ctxMenu.x, ctxMenu.y);
                      setCtxMenu(null);
                    }}
                  >
                    カラムの対応を編集... (ダブルクリックでも可)
                  </button>
                  <div className="context-sep" />
                  <div className="context-caption">線種</div>
                  {(
                    [
                      ["solid", "実線"],
                      ["dashed", "破線"],
                      ["dotted", "点線"],
                    ] as const
                  ).map(([style, label]) => {
                    const checked = curStyle === style;
                    return (
                      <button
                        key={style}
                        className={"context-item" + (checked ? " checked" : "")}
                        onClick={() => {
                          setEdgeStyle(ctxMenu.edge, { style });
                          setCtxMenu(null);
                        }}
                      >
                        {checked ? "✓ " : ""}
                        {label}
                      </button>
                    );
                  })}
                  <div className="er-frame-colors">
                    {FRAME_COLORS.map((color) => {
                      const checked = (es?.color ?? "") === color;
                      return (
                        <button
                          key={color || "default"}
                          className={
                            "er-frame-color" + (checked ? " checked" : "")
                          }
                          style={{ background: color || "#6366f1" }}
                          title={color || "既定 (インディゴ)"}
                          onClick={() => {
                            setEdgeStyle(ctxMenu.edge, {
                              color: color || undefined,
                            });
                            setCtxMenu(null);
                          }}
                        />
                      );
                    })}
                  </div>
                  <div className="context-sep" />
                  {anchors[ek] && (
                    <button
                      className="context-item"
                      onClick={() => {
                        resetAnchors(ctxMenu.edge);
                        setCtxMenu(null);
                      }}
                    >
                      接続位置を自動に戻す
                    </button>
                  )}
                  <button
                    className="context-item danger"
                    onClick={() => {
                      askDeleteEdges([ctxMenu.edge]);
                      setCtxMenu(null);
                    }}
                  >
                    線を削除
                  </button>
                </>
              );
            })()
          ) : ctxMenu.kind === "node" ? (
            <>
              {tableWidths[ctxMenu.table] !== undefined && (
                <button
                  className="context-item"
                  onClick={() => {
                    resetTableWidth(ctxMenu.table);
                    setCtxMenu(null);
                  }}
                >
                  幅を自動 (Fit) に戻す
                </button>
              )}
              {selNodes.size > 1 && selNodes.has(ctxMenu.table) ? (
                <button
                  className="context-item danger"
                  onClick={() => {
                    askDeleteTables([...selNodes]);
                    setCtxMenu(null);
                  }}
                >
                  選択中の{selNodes.size}テーブルを図から削除
                </button>
              ) : (
                <button
                  className="context-item danger"
                  onClick={() => {
                    askDeleteTables([ctxMenu.table]);
                    setCtxMenu(null);
                  }}
                >
                  テーブルを図から削除
                </button>
              )}
            </>
          ) : ctxMenu.kind === "canvas" ? (
            <>
              <button
                className="context-item"
                onClick={() => {
                  addFrame(ctxMenu.worldX, ctxMenu.worldY);
                  setCtxMenu(null);
                }}
              >
                ここに枠を追加
              </button>
              <button
                className="context-item"
                onClick={() => {
                  addText(ctxMenu.worldX, ctxMenu.worldY);
                  setCtxMenu(null);
                }}
              >
                ここにテキストを追加
              </button>
              {removedTables.size > 0 && (
                <>
                  <div className="context-sep" />
                  <button
                    className="context-item"
                    onClick={() => {
                      restoreRemovedTables();
                      setCtxMenu(null);
                    }}
                  >
                    削除したテーブルを戻す ({removedTables.size})
                  </button>
                </>
              )}
            </>
          ) : ctxMenu.kind === "frame" ? (
            (() => {
              const f = frames.find((x) => x.id === ctxMenu.frameId);
              if (!f) return null;
              /** 対象の枠だけ書き換えて保存し、メニューを閉じる */
              const upd = (patch: Partial<ErFrame>) => {
                updateFrames(
                  frames.map((x) => (x.id === f.id ? { ...x, ...patch } : x))
                );
                setCtxMenu(null);
              };
              const remove = () => {
                setCtxMenu(null);
                setConfirm({
                  title: f.kind === "text" ? "テキストを削除" : "枠を削除",
                  message: `「${f.label}」を削除しますか？`,
                  action: () =>
                    updateFrames(frames.filter((x) => x.id !== f.id)),
                });
              };
              const editBtn = (
                <button
                  className="context-item"
                  onClick={() => {
                    startEditing(f);
                    setCtxMenu(null);
                  }}
                >
                  テキストを編集...
                </button>
              );
              if (f.kind === "text") {
                // テキスト見出しのメニュー
                return (
                  <>
                    {editBtn}
                    <div className="context-sep" />
                    <div className="context-caption">文字サイズ (px)</div>
                    <div
                      className="er-size-row"
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <input
                        className="er-size-input"
                        type="number"
                        min={8}
                        max={200}
                        defaultValue={f.fontSize ?? 18}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          const v = Math.round(
                            Number((e.target as HTMLInputElement).value)
                          );
                          if (Number.isFinite(v) && v >= 8 && v <= 200) {
                            upd({ fontSize: v });
                          }
                        }}
                      />
                      <span className="er-size-hint">Enterで適用</span>
                    </div>
                    <div className="er-size-chips">
                      {[14, 18, 24, 32, 48].map((size) => (
                        <button
                          key={size}
                          className={
                            "er-size-chip" +
                            ((f.fontSize ?? 18) === size ? " checked" : "")
                          }
                          onClick={() => upd({ fontSize: size })}
                        >
                          {size}
                        </button>
                      ))}
                    </div>
                    <div className="context-sep" />
                    <div className="context-caption">文字色</div>
                    <div className="er-frame-colors">
                      {FRAME_COLORS.map((color) => {
                        const checked = (f.textColor ?? "") === color;
                        return (
                          <button
                            key={color || "default"}
                            className={
                              "er-frame-color" + (checked ? " checked" : "")
                            }
                            style={{ background: color || "#8b93a8" }}
                            title={color || "グレー (既定)"}
                            onClick={() =>
                              upd({ textColor: color || undefined })
                            }
                          />
                        );
                      })}
                    </div>
                    <div className="context-sep" />
                    <button className="context-item danger" onClick={remove}>
                      テキストを削除
                    </button>
                  </>
                );
              }
              // 枠 (box) のメニュー
              return (
                <>
                  {editBtn}
                  <div className="context-sep" />
                  <div className="context-caption">枠線</div>
                  {(
                    [
                      ["solid", "実線"],
                      ["dashed", "破線"],
                      ["dotted", "点線"],
                      ["none", "枠線なし"],
                    ] as const
                  ).map(([style, label]) => {
                    const checked = f.style === style;
                    return (
                      <button
                        key={style}
                        className={"context-item" + (checked ? " checked" : "")}
                        onClick={() => upd({ style })}
                      >
                        {checked ? "✓ " : ""}
                        {label}
                      </button>
                    );
                  })}
                  <div className="er-frame-colors">
                    {FRAME_COLORS.map((color) => {
                      const checked = (f.color ?? "") === color;
                      return (
                        <button
                          key={color || "default"}
                          className={
                            "er-frame-color" + (checked ? " checked" : "")
                          }
                          style={{ background: color || "#8b93a8" }}
                          title={color || "グレー (既定)"}
                          onClick={() => upd({ color: color || undefined })}
                        />
                      );
                    })}
                  </div>
                  <div className="context-sep" />
                  <div className="context-caption">背景色</div>
                  <div className="er-frame-colors">
                    <button
                      className={
                        "er-frame-color transparent" +
                        (!f.fill ? " checked" : "")
                      }
                      title="透明"
                      onClick={() => upd({ fill: undefined })}
                    />
                    {FRAME_COLORS.slice(1).map((color) => {
                      const checked = f.fill === color;
                      return (
                        <button
                          key={color}
                          className={
                            "er-frame-color" + (checked ? " checked" : "")
                          }
                          style={{ background: color }}
                          title={color}
                          onClick={() => upd({ fill: color })}
                        />
                      );
                    })}
                  </div>
                  <div className="context-sep" />
                  <button
                    className="context-item"
                    onClick={() => upd({ rounded: f.rounded === false })}
                  >
                    {f.rounded === false ? "角丸にする" : "四角にする"}
                  </button>
                  <button
                    className="context-item"
                    onClick={() => upd({ front: !f.front })}
                  >
                    {f.front ? "テーブルの背面に表示" : "テーブルの前面に表示"}
                  </button>
                  <div className="context-sep" />
                  <button className="context-item danger" onClick={remove}>
                    枠を削除
                  </button>
                </>
              );
            })()
          ) : (
            <>
              {selEdge !== null &&
                (() => {
                  // 線を選択した状態でカラムを右クリック → 対応カラムの追加/解除
                  const se = edges[selEdge];
                  if (!se) return null;
                  const side =
                    se.from === ctxMenu.table
                      ? ("from" as const)
                      : se.to === ctxMenu.table
                        ? ("to" as const)
                        : null;
                  if (!side) return null;
                  const primary =
                    side === "from" ? se.fromColumn : se.toColumn;
                  if (ctxMenu.column === primary) return null;
                  const has = (
                    edgeCols[edgeKey(se)]?.[side] ?? []
                  ).includes(ctxMenu.column);
                  const idx = selEdge;
                  return (
                    <>
                      <button
                        className="context-item"
                        onClick={() => {
                          toggleEdgeColumn(idx, side, ctxMenu.column);
                          setCtxMenu(null);
                        }}
                      >
                        {has
                          ? "選択中の線の対応から外す"
                          : "選択中の線の対応に追加"}
                      </button>
                      <div className="context-sep" />
                    </>
                  );
                })()}
              {linkSrc && linkSrc.table !== ctxMenu.table && (
                <button
                  className="context-item"
                  onClick={() => {
                    handleColumnClick(ctxMenu.table, ctxMenu.column);
                    setCtxMenu(null);
                  }}
                >
                  {`${linkSrc.table}.${linkSrc.column} からここへ線を接続`}
                </button>
              )}
              <button
                className="context-item"
                onClick={() => {
                  setLinkMode(true);
                  setLinkSrc({ table: ctxMenu.table, column: ctxMenu.column });
                  setNotice(
                    `接続元: ${ctxMenu.table}.${ctxMenu.column} — 接続先のカラムをクリック (右クリックでも可)`
                  );
                  setCtxMenu(null);
                }}
              >
                この列から線を追加
              </button>
              {linkSrc && (
                <button
                  className="context-item"
                  onClick={() => {
                    setLinkMode(false);
                    setLinkSrc(null);
                    setNotice(null);
                    setCtxMenu(null);
                  }}
                >
                  線の追加をキャンセル
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* 線の編集パネル (カラムの対応をチェックで設定) */}
      {edgePanel &&
        (() => {
          const e = edges[edgePanel.edge];
          if (!e) return null;
          const ek = edgeKey(e);
          const ec = edgeCols[ek] ?? { from: [], to: [] };
          const sides = [
            { side: "from" as const, table: e.from, primary: e.fromColumn },
            { side: "to" as const, table: e.to, primary: e.toColumn },
          ];
          return (
            <div
              className="er-edge-panel"
              style={{ left: edgePanel.x, top: edgePanel.y }}
              onMouseDown={(ev) => ev.stopPropagation()}
            >
              <div className="er-edge-panel-head">
                <span className="mono">
                  {e.from} → {e.to}
                </span>
                <button
                  className="modal-close"
                  onClick={() => setEdgePanel(null)}
                >
                  ×
                </button>
              </div>
              <div className="er-edge-panel-cap">
                対応するカラムにチェック (線を選択すると光ります。複合キーは両側で複数チェック)
              </div>
              <div className="er-edge-panel-cols">
                {sides.map(({ side, table, primary }) => {
                  const ent = entries?.find((x) => x.table.name === table);
                  return (
                    <div key={side} className="er-edge-panel-list">
                      <div className="er-edge-panel-table mono" title={table}>
                        {table}
                      </div>
                      {ent?.detail.columns.map((c) => {
                        const isPrimary = c.name === primary;
                        const checked =
                          isPrimary || ec[side].includes(c.name);
                        return (
                          <label
                            key={c.name}
                            className={
                              "er-edge-panel-item" +
                              (isPrimary ? " primary" : "")
                            }
                            title={
                              isPrimary
                                ? "線の代表カラム (外せません)"
                                : c.name
                            }
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={isPrimary}
                              onChange={() =>
                                toggleEdgeColumn(edgePanel.edge, side, c.name)
                              }
                            />
                            <span className="mono">{c.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

      {/* 削除確認ダイアログ */}
      {confirm && (
        <div className="er-modal-overlay" onMouseDown={() => setConfirm(null)}>
          <div className="er-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="er-modal-head">
              <div className="er-modal-icon danger">✕</div>
              <div>
                <div className="er-modal-title">{confirm.title}</div>
                <div className="er-modal-sub">
                  {confirm.sub ?? "この操作は元に戻せません"}
                </div>
              </div>
            </div>
            <p className="er-modal-body">{confirm.message}</p>
            <div className="er-modal-actions">
              <button
                className="btn-ghost er-modal-cancel"
                onClick={() => setConfirm(null)}
              >
                キャンセル
              </button>
              <button
                className="btn-primary btn-delete"
                autoFocus
                onClick={() => {
                  const a = confirm.action;
                  setConfirm(null);
                  a();
                }}
              >
                削除する
              </button>
            </div>
          </div>
        </div>
      )}

      {/* リバース時の確認ダイアログ */}
      {reverseDialog && (
        <div
          className="er-modal-overlay"
          onMouseDown={() => setReverseDialog(false)}
        >
          <div className="er-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="er-modal-head">
              <div className="er-modal-icon">⟳</div>
              <div>
                <div className="er-modal-title">リバース</div>
                <div className="er-modal-sub mono">
                  {session?.name} / {sel.database}
                </div>
              </div>
            </div>
            <p className="er-modal-body">
              図に無い新規のテーブルも読み込みますか？
              <br />
              「読み込まない」でも既存テーブルのカラムの増減は反映されます。
            </p>
            {removedTables.size > 0 && (
              <label className="er-modal-check">
                <input
                  type="checkbox"
                  checked={reviveTables}
                  onChange={(e) => setReviveTables(e.target.checked)}
                />
                図から削除したテーブル ({removedTables.size}件) も復活させる
              </label>
            )}
            <div className="er-modal-actions">
              <button
                className="btn-ghost er-modal-cancel"
                onClick={() => setReverseDialog(false)}
              >
                キャンセル
              </button>
              <button
                className="btn-secondary"
                onClick={() => {
                  setReverseDialog(false);
                  doReverse(false, reviveTables);
                }}
              >
                読み込まない
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  setReverseDialog(false);
                  doReverse(true, reviveTables);
                }}
              >
                読み込む
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 図の名前入力ダイアログ */}
      {nameDialog && (
        <div
          className="er-modal-overlay"
          onMouseDown={() => setNameDialog(null)}
        >
          <div className="er-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="er-modal-head">
              <div className="er-modal-icon">✎</div>
              <div>
                <div className="er-modal-title">
                  {nameDialog.mode === "saveAs"
                    ? "名前を付けて保存"
                    : "名前を変更"}
                </div>
                <div className="er-modal-sub">
                  どの接続からでもこの名前で開けます
                </div>
              </div>
            </div>
            <input
              className="er-modal-input"
              value={nameDialog.value}
              autoFocus
              placeholder="例: 受注まわり"
              onChange={(e) =>
                setNameDialog({ ...nameDialog, value: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") commitNameDialog();
                else if (e.key === "Escape") setNameDialog(null);
              }}
            />
            <div className="er-modal-actions">
              <button
                className="btn-ghost er-modal-cancel"
                onClick={() => setNameDialog(null)}
              >
                キャンセル
              </button>
              <button
                className="btn-primary"
                disabled={!nameDialog.value.trim()}
                onClick={commitNameDialog}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
