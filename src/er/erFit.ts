/**
 * ER図の「全体表示 (Fit)」で使う、図が占めている範囲の計算。
 *
 * 表示の都合 (キャンバスの大きさ・拡大率) とは切り離してあるので、
 * ここは数だけを見る
 */

/** 図の中の箱1つ (テーブル) */
export interface ErBoxNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 図全体が占めている四角 */
export interface ErBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * 置いてある箱を全部囲む四角を返す。
 *
 * 左や上へ動かしたテーブルは座標がマイナスになる。
 * 右下だけを見て「0,0 から始まる」と決めてしまうと、
 * そのテーブルが画面の外に置き去りになるので、左上も必ず測る。
 * 箱が1つも無ければ null (合わせようがない)
 */
export function boundingBox(nodes: ErBoxNode[]): ErBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/** 合わせたあとの表示 (どこに、どの大きさで出すか) */
export interface FitView {
  x: number;
  y: number;
  scale: number;
}

/** 全体表示の決め方 */
export interface FitLimits {
  /** キャンバスの大きさ (px) */
  width: number;
  height: number;
  /** まわりに残す余白 (px) */
  pad: number;
  /** 拡大率の下限・上限 */
  minScale: number;
  maxScale: number;
}

/**
 * 図全体がキャンバスに収まる表示を求める。
 *
 * 収めたうえで、余ったぶんは上下左右へ均等に配って真ん中に置く。
 * 小さい図を無理に引き伸ばさないよう、拡大率には上限がある
 */
export function fitView(box: ErBox, lim: FitLimits): FitView {
  // 幅・高さが0 (箱1つを点とみなす場合など) でも割り算が壊れないようにする
  const w = Math.max(1, box.maxX - box.minX);
  const h = Math.max(1, box.maxY - box.minY);
  const room = (v: number) => Math.max(1, v - lim.pad * 2);
  const scale = Math.max(
    lim.minScale,
    Math.min(lim.maxScale, room(lim.width) / w, room(lim.height) / h)
  );
  return {
    scale,
    // 図の左上を、余白を均等に取った位置へ持ってくる
    x: (lim.width - w * scale) / 2 - box.minX * scale,
    y: (lim.height - h * scale) / 2 - box.minY * scale,
  };
}
