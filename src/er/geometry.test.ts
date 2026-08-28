import { describe, expect, it } from "vitest";
import {
  anchorPointPos,
  anchorY,
  colSideAnchor,
  edgePath,
  edgePoints,
  nearestBorderAnchor,
  pathClear,
  routeAnchored,
  routeAvoid,
  segHitsRect,
  sideDir,
  simplifyPath,
  verticalSegments,
} from "./geometry";
import { NODE_HEAD_H, ROW_H, type ErNode } from "./model";

/** テスト用のノード (カラム3本) */
const node = (w = 200, h = 100): ErNode => ({
  name: "t",
  logical: "",
  w,
  h,
  columns: ["a", "b", "c"].map((name) => ({
    name,
    isPk: false,
    notNull: false,
    type: "",
    logical: "",
  })),
});

describe("anchorY", () => {
  it("カラムの行の中心を返す", () => {
    const n = node();
    expect(anchorY(n, 0, "a")).toBe(NODE_HEAD_H + ROW_H / 2);
    expect(anchorY(n, 0, "b")).toBe(NODE_HEAD_H + ROW_H + ROW_H / 2);
    // 上端の座標ぶんずれる
    expect(anchorY(n, 50, "a")).toBe(50 + NODE_HEAD_H + ROW_H / 2);
  });

  it("表示していないカラムはヘッダの中心", () => {
    expect(anchorY(node(), 0, "zzz")).toBe(NODE_HEAD_H / 2);
  });
});

describe("edgePoints", () => {
  it("左→右は間の中央で折れる", () => {
    const pts = edgePoints({ x: 0, w: 100 }, 10, { x: 200, w: 100 }, 60);
    expect(pts).toEqual([
      [100, 10],
      [150, 10],
      [150, 60],
      [200, 60],
    ]);
  });

  it("右→左は左向きに出て、間の中央で折れる", () => {
    const pts = edgePoints({ x: 300, w: 100 }, 10, { x: 0, w: 100 }, 60);
    expect(pts).toEqual([
      [300, 10],
      [200, 10],
      [200, 60],
      [100, 60],
    ]);
  });

  it("横に重なっているときは右側を回り込む", () => {
    const pts = edgePoints({ x: 0, w: 100 }, 10, { x: 20, w: 100 }, 60);
    const outer = Math.max(100, 120) + 34;
    expect(pts[1][0]).toBe(outer);
    expect(pts[2][0]).toBe(outer);
  });
});

describe("verticalSegments", () => {
  it("縦に動く区間だけ拾う", () => {
    expect(
      verticalSegments([
        [0, 0],
        [10, 0],
        [10, 40],
        [30, 40],
      ])
    ).toEqual([{ x: 10, y1: 0, y2: 40 }]);
  });

  it("同じ点が続くだけなら区間にしない", () => {
    expect(
      verticalSegments([
        [5, 5],
        [5, 5],
      ])
    ).toEqual([]);
  });
});

describe("edgePath", () => {
  it("交差が無ければ直線の連なりになる", () => {
    const d = edgePath(
      [
        [0, 0],
        [50, 0],
      ],
      []
    );
    expect(d).toBe("M 0 0 L 50 0");
  });

  it("横線が縦線と交差する位置に半円を入れる", () => {
    const d = edgePath(
      [
        [0, 20],
        [100, 20],
      ],
      [{ x: 50, y1: 0, y2: 40 }]
    );
    expect(d).toContain("A ");
    expect(d.endsWith("L 100 20")).toBe(true);
  });

  it("端に近すぎる交差は飛び越えない", () => {
    const d = edgePath(
      [
        [0, 20],
        [100, 20],
      ],
      [{ x: 1, y1: 0, y2: 40 }]
    );
    expect(d).not.toContain("A ");
  });

  it("縦線の範囲外を通るだけなら飛び越えない", () => {
    const d = edgePath(
      [
        [0, 20],
        [100, 20],
      ],
      [{ x: 50, y1: 100, y2: 200 }]
    );
    expect(d).not.toContain("A ");
  });
});

describe("segHitsRect", () => {
  const r = { x: 0, y: 0, w: 100, h: 100 };

  it("内部を横切れば当たり", () => {
    expect(segHitsRect(-10, 50, 110, 50, r)).toBe(true);
    expect(segHitsRect(50, -10, 50, 110, r)).toBe(true);
  });

  it("境界をなぞるだけなら当たらない", () => {
    expect(segHitsRect(-10, 0, 110, 0, r)).toBe(false);
    expect(segHitsRect(0, -10, 0, 110, r)).toBe(false);
    expect(segHitsRect(-10, 100, 110, 100, r)).toBe(false);
  });

  it("離れていれば当たらない", () => {
    expect(segHitsRect(-10, 200, 110, 200, r)).toBe(false);
  });

  it("斜めの線は扱わない", () => {
    expect(segHitsRect(-10, -10, 110, 110, r)).toBe(false);
  });
});

describe("pathClear", () => {
  const r = { x: 0, y: 0, w: 100, h: 100 };

  it("どこも通らなければtrue", () => {
    expect(
      pathClear(
        [
          [-50, 50],
          [-50, 200],
        ],
        [r]
      )
    ).toBe(true);
  });

  it("1区間でも通ればfalse", () => {
    expect(
      pathClear(
        [
          [-50, 50],
          [50, 50],
        ],
        [r]
      )
    ).toBe(false);
  });
});

describe("simplifyPath", () => {
  it("重複した点を落とす", () => {
    expect(
      simplifyPath([
        [0, 0],
        [0, 0],
        [10, 0],
      ])
    ).toEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it("一直線上の中間点を落とす", () => {
    expect(
      simplifyPath([
        [0, 0],
        [10, 0],
        [20, 0],
        [20, 20],
      ])
    ).toEqual([
      [0, 0],
      [20, 0],
      [20, 20],
    ]);
  });
});

describe("sideDir", () => {
  it("辺の外向きを返す", () => {
    expect(sideDir("left")).toEqual([-1, 0]);
    expect(sideDir("right")).toEqual([1, 0]);
    expect(sideDir("top")).toEqual([0, -1]);
    expect(sideDir("bottom")).toEqual([0, 1]);
  });
});

describe("anchorPointPos", () => {
  const n = node(200, 100);
  const p = { x: 10, y: 20 };

  it("辺ごとに境界上の座標を返す", () => {
    expect(anchorPointPos(n, p, { side: "top", t: 0.5 })).toEqual({
      x: 110,
      y: 20,
      side: "top",
    });
    expect(anchorPointPos(n, p, { side: "bottom", t: 0 })).toEqual({
      x: 10,
      y: 120,
      side: "bottom",
    });
    expect(anchorPointPos(n, p, { side: "left", t: 1 })).toEqual({
      x: 10,
      y: 120,
      side: "left",
    });
    expect(anchorPointPos(n, p, { side: "right", t: 0.5 })).toEqual({
      x: 210,
      y: 70,
      side: "right",
    });
  });
});

describe("colSideAnchor", () => {
  const n = node(200, 100);
  const p = { x: 0, y: 0 };

  it("相手が右にいれば右辺から出る", () => {
    expect(colSideAnchor(n, p, "a", 500).side).toBe("right");
  });

  it("相手が左にいれば左辺から出る", () => {
    expect(colSideAnchor(n, p, "a", -500).side).toBe("left");
  });

  it("Yはカラム行の中心", () => {
    expect(colSideAnchor(n, p, "b", 500).y).toBe(anchorY(n, 0, "b"));
  });
});

describe("nearestBorderAnchor", () => {
  const n = node(200, 100);
  const p = { x: 0, y: 0 };

  it("いちばん近い辺を選ぶ", () => {
    expect(nearestBorderAnchor(n, p, 100, -30).side).toBe("top");
    expect(nearestBorderAnchor(n, p, 100, 130).side).toBe("bottom");
    expect(nearestBorderAnchor(n, p, -30, 50).side).toBe("left");
    expect(nearestBorderAnchor(n, p, 230, 50).side).toBe("right");
  });

  it("割合は0〜1に収める", () => {
    const a = nearestBorderAnchor(n, p, -999, -999);
    expect(a.t).toBeGreaterThanOrEqual(0);
    expect(a.t).toBeLessThanOrEqual(1);
  });

  it("左右の辺ではカラム行の中心に吸着する", () => {
    const rowY = NODE_HEAD_H + ROW_H / 2;
    const a = nearestBorderAnchor(n, p, -10, rowY + 3);
    expect(a.side).toBe("left");
    expect(a.t * n.h).toBeCloseTo(rowY, 6);
  });

  it("行の中心から離れていれば吸着しない", () => {
    // 60 はどのカラム行の中心 (34.5 / 51.5 / 68.5) からも7px以上離れている
    const a = nearestBorderAnchor(n, p, -10, 60);
    expect(a.side).toBe("left");
    expect(a.t * n.h).toBeCloseTo(60, 6);
  });
});

describe("routeAnchored", () => {
  it("両端から外へ出てから折れる", () => {
    const pts = routeAnchored(
      { x: 100, y: 50, side: "right" },
      { x: 300, y: 90, side: "left" }
    );
    expect(pts[0]).toEqual([100, 50]);
    expect(pts[pts.length - 1]).toEqual([300, 90]);
    // 直角に折れるだけ (斜めは無い)
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      expect(x0 === x1 || y0 === y1).toBe(true);
    }
  });
});

describe("routeAvoid", () => {
  it("間にあるテーブルを避けた経路になる", () => {
    const wall = { x: 140, y: -200, w: 40, h: 400 };
    const pts = routeAvoid(
      { x: 100, y: 0, side: "right" },
      { x: 300, y: 0, side: "left" },
      [wall]
    );
    expect(pts).not.toBeNull();
    expect(pts![0]).toEqual([100, 0]);
    expect(pts![pts!.length - 1]).toEqual([300, 0]);
    // 経路全体が矩形の内部を通らない (アンカーから出る垂線も含めて)
    expect(pathClear(pts!, [wall])).toBe(true);
  });

  it("障害物が無ければ素直な経路になる", () => {
    const pts = routeAvoid(
      { x: 100, y: 0, side: "right" },
      { x: 300, y: 0, side: "left" },
      []
    );
    expect(pts).toEqual([
      [100, 0],
      [300, 0],
    ]);
  });
});
