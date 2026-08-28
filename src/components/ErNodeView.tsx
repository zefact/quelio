import { memo, type CSSProperties } from "react";
import { colMarker, colTracks, NODE_HEAD_H, ROW_H, type ErNode } from "../er/model";

interface Props {
  node: ErNode;
  x: number;
  y: number;
  /** 選択中のリレーションにつながっているテーブルか */
  related: boolean;
  selected: boolean;
  /** 強調するカラム名 (選択中のリレーションの接続カラムなど) */
  highlighted: Set<string>;
  /** クリックで選択中のカラム (このテーブル内のもの) */
  selectedColumn: string | null;
  showTypes: boolean;
  showLogical: boolean;
  /** 行の両端に接続ハンドルを出すか (マウスが乗っているテーブルだけ) */
  showHandles: boolean;
  /*
   * 操作の通知には、どのテーブルかを必ず添える。
   * 呼び出し側がテーブルごとに関数を作らずに済み、
   * 下の memo が効くようになる
   */
  onNodeMouseDown: (e: React.MouseEvent, table: string) => void;
  onHoverChange: (hovered: boolean, table: string) => void;
  onHeadContextMenu: (e: React.MouseEvent, table: string) => void;
  onColumnClick: (table: string, column: string) => void;
  onColumnContextMenu: (
    e: React.MouseEvent,
    table: string,
    column: string
  ) => void;
  onHandleMouseDown: (
    e: React.MouseEvent,
    table: string,
    column: string
  ) => void;
  onResizeMouseDown: (e: React.MouseEvent, table: string) => void;
}

function ErNodeViewInner({
  node: n,
  x,
  y,
  related,
  selected,
  highlighted,
  selectedColumn,
  showTypes,
  showLogical,
  showHandles,
  onNodeMouseDown,
  onHoverChange,
  onHeadContextMenu,
  onColumnClick,
  onColumnContextMenu,
  onHandleMouseDown,
  onResizeMouseDown,
}: Props) {
  const rowSelIdx = selectedColumn
    ? n.columns.findIndex((c) => c.name === selectedColumn)
    : -1;

  /*
   * 行の高さはCSSにも要るが、線のつなぎ目 (anchorY) と必ず一致していないと
   * 線が行からずれる。二重に持たず、TS側の ROW_H をCSS変数で渡す
   */
  const colsStyle: CSSProperties & { [key: `--${string}`]: string } = {
    gridTemplateColumns: colTracks(showTypes, showLogical),
    "--er-row-h": `${ROW_H}px`,
  };

  return (
    <div
      className={
        "er-node" + (related ? " related" : "") + (selected ? " selected" : "")
      }
      style={{ left: x, top: y, width: n.w, height: n.h }}
      onMouseDown={(e) => onNodeMouseDown(e, n.name)}
      onMouseEnter={() => onHoverChange(true, n.name)}
      onMouseLeave={() => onHoverChange(false, n.name)}
    >
      <div
        className="er-node-head mono"
        title={n.logical ? `${n.name} (${n.logical})` : n.name}
        onMouseDown={(e) => onNodeMouseDown(e, n.name)}
        onContextMenu={(e) => onHeadContextMenu(e, n.name)}
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
      <div className="er-node-cols mono" style={colsStyle}>
        {n.columns.map((c, i) => (
          // 行ごとにまとめる (display:contents なので見た目は変わらない)。
          // ●ハンドルはCSSのhoverだけで出し入れする
          <div className="er-col-row" key={i}>
            <span
              className={
                "er-col-name" +
                (c.isPk ? " pk" : "") +
                (highlighted.has(c.name) ? " hl" : "") +
                (selectedColumn === c.name ? " sel" : "")
              }
              title={
                c.name +
                (c.isPk
                  ? " (主キー)"
                  : c.notNull
                    ? " (NOT NULL)"
                    : " (NULL可)")
              }
              onClick={() => onColumnClick(n.name, c.name)}
              onContextMenu={(ev) => onColumnContextMenu(ev, n.name, c.name)}
            >
              {colMarker(c)}
              {c.name}
            </span>
            {showTypes && (
              <span
                className={
                  "er-col-type" + (selectedColumn === c.name ? " sel" : "")
                }
                title={c.type}
                onClick={() => onColumnClick(n.name, c.name)}
              >
                {c.type}
              </span>
            )}
            {showLogical && (
              <span
                className={
                  "er-col-logical" + (selectedColumn === c.name ? " sel" : "")
                }
                title={c.logical}
                onClick={() => onColumnClick(n.name, c.name)}
              >
                {c.logical}
              </span>
            )}
            {/* この行の両端に出る接続ハンドル (表示はCSSのhover) */}
            {showHandles &&
              (["left", "right"] as const).map((side) => (
                <div
                  key={side}
                  className={`er-link-handle ${side}`}
                  style={{ top: NODE_HEAD_H + i * ROW_H + ROW_H / 2 - 5.5 }}
                  title="ドラッグして相手のカラムへ線をつなぐ"
                  onMouseDown={(e) => onHandleMouseDown(e, n.name, c.name)}
                />
              ))}
          </div>
        ))}
      </div>
      <div
        className="er-node-resize"
        title="ドラッグで幅を調整 (右クリックメニューで自動に戻せます)"
        onMouseDown={(e) => onResizeMouseDown(e, n.name)}
      />
    </div>
  );
}

/** 中身が同じ集合か (ハイライトは描画のたびに作り直されるため) */
function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * ER図のテーブル1つぶんの表示。
 *
 * 図の移動・拡大では中身が変わらないので、
 * 変わったテーブルだけを描き直す (数百テーブルでも移動が重くならない)。
 * 操作の通知は呼び出し側で固定してあるので、そのまま比べてよい
 */
export const ErNodeView = memo(ErNodeViewInner, (p, q) => {
  return (
    p.node === q.node &&
    p.x === q.x &&
    p.y === q.y &&
    p.related === q.related &&
    p.selected === q.selected &&
    p.selectedColumn === q.selectedColumn &&
    p.showTypes === q.showTypes &&
    p.showLogical === q.showLogical &&
    p.showHandles === q.showHandles &&
    sameSet(p.highlighted, q.highlighted) &&
    p.onNodeMouseDown === q.onNodeMouseDown &&
    p.onHoverChange === q.onHoverChange &&
    p.onHeadContextMenu === q.onHeadContextMenu &&
    p.onColumnClick === q.onColumnClick &&
    p.onColumnContextMenu === q.onColumnContextMenu &&
    p.onHandleMouseDown === q.onHandleMouseDown &&
    p.onResizeMouseDown === q.onResizeMouseDown
  );
});
