import { edgeKey, type ErEdge } from "../er/model";
import { edgePath } from "../er/geometry";
import type { ErEdgeStyle } from "../types";

interface Props {
  edges: ErEdge[];
  /** 線ごとの折れ点 (引けないものは null) */
  geoms: ([number, number][] | null)[];
  /** 線ごとの見た目の上書き (キーは edgeKey) */
  styles: Record<string, ErEdgeStyle | undefined>;
  /** 選択中の線 (端点ハンドルを出す1本) */
  selected: number | null;
  /** 範囲選択などで選ばれている線 */
  selectedSet: Set<number>;
  width: number;
  height: number;
  /** 再描画の目印 (アニメーションを打ち切るために使う) */
  rev: number;
  /** 自分以外の垂直区間 (交差の飛び越えに使う) */
  verticalsExcept: (index: number) => { x: number; y1: number; y2: number }[];
  /** ドラッグで接続中のプレビュー線 */
  preview: { x1: number; y1: number; x2: number; y2: number } | null;
  onSelect: (index: number) => void;
  onOpenPanel: (index: number, clientX: number, clientY: number) => void;
  onContextMenu: (index: number, clientX: number, clientY: number) => void;
  onAnchorMouseDown: (
    e: React.MouseEvent,
    index: number,
    end: "from" | "to"
  ) => void;
}

/** ER図の線 (リレーション) を描くSVGレイヤー */
export function ErEdgeLayer({
  edges,
  geoms,
  styles,
  selected,
  selectedSet,
  width,
  height,
  rev,
  verticalsExcept,
  preview,
  onSelect,
  onOpenPanel,
  onContextMenu,
  onAnchorMouseDown,
}: Props) {
  return (
    <svg
      className={
        "er-edges" + (selected !== null || selectedSet.size > 0 ? " has-sel" : "")
      }
      width={width}
      height={height}
      data-rev={rev}
    >
      {[...edges.keys()]
        // 選択中のエッジを最後に描いて最前面に出す
        .sort((x, y) => (x === selected ? 1 : 0) - (y === selected ? 1 : 0))
        .map((i) => {
          const e = edges[i];
          const pts = geoms[i];
          if (!pts) return null;
          const ptsStr = pts.map((p) => p.join(",")).join(" ");
          const first = pts[0];
          const last = pts[pts.length - 1];
          // 線種・色の上書き (選択中の色はハイライトを優先)
          const isSel = i === selected || selectedSet.has(i);
          const es = styles[edgeKey(e)];
          const dash =
            es?.style === "solid"
              ? "none"
              : es?.style === "dotted"
                ? "2 4"
                : undefined;
          const strokeColor = isSel ? undefined : es?.color || undefined;
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
                style={{ stroke: strokeColor, strokeDasharray: dash }}
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
                  onSelect(i);
                }}
                onDoubleClick={(ev) => {
                  ev.stopPropagation();
                  onOpenPanel(i, ev.clientX, ev.clientY);
                }}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  onContextMenu(i, ev.clientX, ev.clientY);
                }}
              />
              {i === selected && (
                <>
                  <circle
                    className="er-edge-handle"
                    cx={first[0]}
                    cy={first[1]}
                    r={5.5}
                    onMouseDown={(ev) => onAnchorMouseDown(ev, i, "from")}
                  >
                    <title>ドラッグで接続位置を変更 ({e.from})</title>
                  </circle>
                  <circle
                    className="er-edge-handle"
                    cx={last[0]}
                    cy={last[1]}
                    r={5.5}
                    onMouseDown={(ev) => onAnchorMouseDown(ev, i, "to")}
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
      {preview && (
        <path
          className="er-link-preview"
          d={`M ${preview.x1} ${preview.y1} L ${preview.x2} ${preview.y2}`}
        />
      )}
    </svg>
  );
}
