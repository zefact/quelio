import { ReactNode, useEffect, useRef, useState } from "react";
import { HoverTip } from "./HoverTip";

export interface GridColumn {
  id: string;
  label: string;
  /** 初期幅(px) */
  width: number;
  minWidth?: number;
  align?: "left" | "center" | "right";
  /** trueで折り返して全文表示 (コメント列など) */
  wrap?: boolean;
  /** ヘッダにマウスを乗せたときの説明ツールチップ */
  description?: string;
}

export interface GridRow {
  key: string;
  cells: ReactNode[];
}

export interface SortState {
  id: string;
  dir: "asc" | "desc";
}

interface Props {
  columns: GridColumn[];
  rows: GridRow[];
  emptyText?: string;
  /** 指定するとヘッダクリックでソート切替を通知する */
  sort?: SortState | null;
  onSortToggle?: (id: string) => void;
  /** trueなら初期表示時に全列を内容にフィットさせる */
  autoFit?: boolean;
}

/** ダブルクリックfit時の最大幅 */
const FIT_MAX = 700;

/** 列幅をドラッグで変更できるテーブル。
 *  コンテナが広い場合は最後の列が伸びて幅いっぱいに広がる。
 *  リサイザをダブルクリックするとその列を内容にフィットさせる。 */
export function ResizableGrid({
  columns,
  rows,
  emptyText,
  sort,
  onSortToggle,
  autoFit,
}: Props) {
  const [widths, setWidths] = useState<Record<string, number>>(() =>
    Object.fromEntries(columns.map((c) => [c.id, c.width]))
  );

  // 列構成が変わった場合 (表示モード切替など) に新しい列の幅を補う
  useEffect(() => {
    setWidths((w) => {
      let changed = false;
      const next = { ...w };
      for (const c of columns) {
        if (next[c.id] === undefined) {
          next[c.id] = c.width;
          changed = true;
        }
      }
      return changed ? next : w;
    });
  }, [columns]);
  const dragging = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [containerW, setContainerW] = useState(0);

  // コンテナ幅を監視 (ウィンドウリサイズやペイン幅変更に追従)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setContainerW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const startResize = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    const startX = e.clientX;
    const startW = widths[id];
    const min = columns.find((c) => c.id === id)?.minWidth ?? 50;
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";

    const move = (ev: MouseEvent) => {
      const next = Math.max(min, startW + ev.clientX - startX);
      setWidths((w) => ({ ...w, [id]: next }));
    };
    const up = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", move);
      document.body.style.cursor = prevCursor;
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** 列インデックスの内容フィット幅を計測する (DOM未描画ならnull) */
  const measureColumn = (idx: number): number | null => {
    const table = tableRef.current;
    if (!table || idx < 0) return null;
    const cells = table.querySelectorAll(
      `tr > *:nth-child(${idx + 1})`
    ) as NodeListOf<HTMLElement>;
    if (cells.length === 0) return null;

    // 計測用の非表示スパンで各セルのテキスト幅を測る。
    // フォントはセル内の実要素(等幅spanなど)から個別プロパティで引き継ぐ
    // (WebKitはfontショートハンドの取得が不安定なため)
    const meas = document.createElement("span");
    meas.style.cssText =
      "position:absolute;visibility:hidden;white-space:nowrap;left:-99999px;";
    document.body.appendChild(meas);
    let max = 40;
    cells.forEach((cell) => {
      const inner = (cell.firstElementChild as HTMLElement | null) ?? cell;
      const fs = getComputedStyle(inner);
      meas.style.fontFamily = fs.fontFamily;
      meas.style.fontSize = fs.fontSize;
      meas.style.fontWeight = fs.fontWeight;
      meas.style.fontStyle = fs.fontStyle;
      meas.style.letterSpacing = fs.letterSpacing;
      meas.textContent = cell.textContent ?? "";
      const cs = getComputedStyle(cell);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      max = Math.max(max, meas.offsetWidth + pad + 12);
    });
    meas.remove();

    const min = columns[idx].minWidth ?? 50;
    return Math.min(FIT_MAX, Math.max(min, Math.ceil(max)));
  };

  /** リサイザのダブルクリックで列幅を内容にフィットさせる */
  const fitColumn = (id: string) => {
    const idx = columns.findIndex((c) => c.id === id);
    const w = measureColumn(idx);
    if (w !== null) {
      setWidths((prev) => ({ ...prev, [id]: w }));
    }
  };

  // autoFit: 行が描画されたら全列を内容にフィットさせる
  useEffect(() => {
    if (!autoFit || rows.length === 0) return;
    const raf = requestAnimationFrame(() => {
      setWidths((prev) => {
        const next = { ...prev };
        columns.forEach((c, i) => {
          const w = measureColumn(i);
          if (w !== null) next[c.id] = w;
        });
        return next;
      });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFit, rows, columns]);

  // コンテナに余りがある場合は最後の列を伸ばして幅いっぱいにする
  const lastId = columns[columns.length - 1]?.id;
  const sumOthers = columns
    .slice(0, -1)
    .reduce((sum, c) => sum + widths[c.id], 0);
  const lastW = lastId
    ? Math.max(widths[lastId], containerW - sumOthers - 2)
    : 0;
  const renderW = (id: string) => (id === lastId ? lastW : widths[id]);
  const total = sumOthers + lastW;

  return (
    <div className="grid-wrap" ref={wrapRef}>
      <table
        ref={tableRef}
        className="grid resizable"
        style={{ width: total, tableLayout: "fixed" }}
      >
        <colgroup>
          {columns.map((c) => (
            <col key={c.id} style={{ width: renderW(c.id) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.id}
                className={(c.align ?? "") + (onSortToggle ? " sortable" : "")}
                onClick={onSortToggle ? () => onSortToggle(c.id) : undefined}
              >
                <HoverTip className="th-label" text={c.description}>
                  {c.label}
                  {sort?.id === c.id && (
                    <span className="sort-arrow">
                      {sort.dir === "asc" ? "▲" : "▼"}
                    </span>
                  )}
                </HoverTip>
                <span
                  className="col-resizer"
                  title="ドラッグで幅変更 / ダブルクリックで内容にフィット"
                  onMouseDown={(e) => startResize(c.id, e)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    fitColumn(c.id);
                  }}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((cell, i) => {
                const c = columns[i];
                const cls = [c.align ?? "", c.wrap ? "wrap" : ""]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <td key={c.id} className={cls}>
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
          {rows.length === 0 && emptyText && (
            <tr>
              <td colSpan={columns.length} className="faint">
                {emptyText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
