/**
 * ER図の自動レイアウト (force-directed / Fruchterman-Reingold + 重なり解消)。
 *
 * - リレーションのあるテーブル同士は引力で近づき、全ノードは反発で散らばる
 * - 最後に矩形同士の重なりを解消する
 * - 乱数はシード固定なので、同じスキーマなら毎回同じ配置になる
 */

interface LayoutNode {
  name: string;
  w: number;
  h: number;
}

interface LayoutEdge {
  from: string;
  to: string;
}

/** シード固定の擬似乱数 (mulberry32) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ノード位置 (左上座標) を計算して返す */
export function layoutEr(
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const n = nodes.length;
  if (n === 0) return pos;

  const rand = mulberry32(42);

  // ノードの合計面積から全体の広さを決める
  const totalArea = nodes.reduce((a, nd) => a + (nd.w + 70) * (nd.h + 70), 0);
  const side = Math.sqrt(totalArea) * 1.5;
  const k = Math.sqrt((side * side) / n);

  const idx = new Map(nodes.map((nd, i) => [nd.name, i]));
  // 座標はノード中心で扱う
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = rand() * side;
    py[i] = rand() * side;
  }

  const es: [number, number][] = [];
  for (const e of edges) {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) es.push([a, b]);
  }

  const dispX = new Float64Array(n);
  const dispY = new Float64Array(n);
  const ITER = 250;
  for (let it = 0; it < ITER; it++) {
    dispX.fill(0);
    dispY.fill(0);
    // 反発 (全ペア)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = px[i] - px[j];
        let dy = py[i] - py[j];
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = rand() - 0.5;
          dy = rand() - 0.5;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const f = (k * k) / d;
        dispX[i] += (dx / d) * f;
        dispY[i] += (dy / d) * f;
        dispX[j] -= (dx / d) * f;
        dispY[j] -= (dy / d) * f;
      }
    }
    // 引力 (リレーションで結ばれたノード同士)
    for (const [a, b] of es) {
      const dx = px[a] - px[b];
      const dy = py[a] - py[b];
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const f = (d * d) / k;
      dispX[a] -= (dx / d) * f;
      dispY[a] -= (dy / d) * f;
      dispX[b] += (dx / d) * f;
      dispY[b] += (dy / d) * f;
    }
    // 温度を下げながら移動し、枠 (side×side) の中に収める。
    // クランプしないと反発で無限に広がってしまい、画面外に飛び散る
    const t = side * 0.1 * (1 - it / ITER) + 2;
    for (let i = 0; i < n; i++) {
      const d = Math.max(Math.hypot(dispX[i], dispY[i]), 0.01);
      px[i] += (dispX[i] / d) * Math.min(d, t);
      py[i] += (dispY[i] / d) * Math.min(d, t);
      px[i] = Math.min(side, Math.max(0, px[i]));
      py[i] = Math.min(side, Math.max(0, py[i]));
    }
  }

  // 矩形の重なり解消 (重なっていたら小さい軸方向に押し離す)
  const GAP = 28;
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ovX =
          (nodes[i].w + nodes[j].w) / 2 + GAP - Math.abs(px[i] - px[j]);
        const ovY =
          (nodes[i].h + nodes[j].h) / 2 + GAP - Math.abs(py[i] - py[j]);
        if (ovX > 0 && ovY > 0) {
          moved = true;
          if (ovX < ovY) {
            const s = (px[i] < px[j] ? -1 : 1) * (ovX / 2 + 1);
            px[i] += s;
            px[j] -= s;
          } else {
            const s = (py[i] < py[j] ? -1 : 1) * (ovY / 2 + 1);
            py[i] += s;
            py[j] -= s;
          }
        }
      }
    }
    if (!moved) break;
  }

  // 左上を原点に寄せて左上座標に変換する
  let minX = Infinity;
  let minY = Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, px[i] - nodes[i].w / 2);
    minY = Math.min(minY, py[i] - nodes[i].h / 2);
  }
  nodes.forEach((nd, i) => {
    pos.set(nd.name, {
      x: px[i] - nd.w / 2 - minX + 20,
      y: py[i] - nd.h / 2 - minY + 20,
    });
  });
  return pos;
}
