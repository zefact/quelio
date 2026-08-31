/**
 * ピン留めした結果と、今の結果を横に並べて見比べる画面。
 *
 * 「直す前」と「直したあと」を目で追えるようにするのが目的なので、
 * 表としての機能 (並べ替え・ページ送り・全文表示) は付けず、
 * 件数の差と、増えた行・消えた行の色分けだけに絞っている
 */
import { useMemo } from "react";
import { columnKinds, kindAlign, kindClass } from "../cellKind";
import { diffResults } from "../resultDiff";
import { GridColumn, GridRow, ResizableGrid } from "./ResizableGrid";
import type { QueryResult } from "../types";

/** 見比べる片側 */
export interface ComparePane {
  /** 見出し (ピン留めした時刻やSQLの先頭) */
  label: string;
  /** 元のSQL (見出しのツールチップに出す) */
  sql: string;
  columns: string[];
  rows: (string | null)[][];
}

interface Props {
  left: ComparePane;
  right: ComparePane;
}

/** 表として出せる形に整える (差分の行だけ色を変える) */
function toGrid(
  pane: ComparePane,
  marked: Set<number>,
  markClass: string
): { columns: GridColumn[]; rows: GridRow[] } {
  const kinds = columnKinds(pane.rows, pane.columns.length);
  const columns: GridColumn[] = pane.columns.map((name, i) => ({
    id: `c${i}`,
    label: name,
    width: Math.min(240, Math.max(90, name.length * 10 + 40)),
    minWidth: 60,
    align: kindAlign(kinds[i] ?? "text"),
    cellClass: kindClass(kinds[i] ?? "text"),
  }));
  const rows: GridRow[] = pane.rows.map((cells, i) => ({
    key: String(i),
    className: marked.has(i) ? markClass : undefined,
    cells: cells.map((v) =>
      v === null ? <span className="null-cell">NULL</span> : <span>{v}</span>
    ),
  }));
  return { columns, rows };
}

export function ResultCompare({ left, right }: Props) {
  const diff = useMemo(
    () => diffResults(left.columns, left.rows, right.columns, right.rows),
    [left, right]
  );
  const leftGrid = useMemo(
    () => toGrid(left, diff.onlyLeft, "row-removed"),
    [left, diff]
  );
  const rightGrid = useMemo(
    () => toGrid(right, diff.onlyRight, "row-added"),
    [right, diff]
  );

  const delta = right.rows.length - left.rows.length;

  return (
    <div className="result-compare">
      <div className="compare-summary">
        <span className="mono">
          {left.rows.length.toLocaleString()}行 →{" "}
          {right.rows.length.toLocaleString()}行
        </span>
        <span className={"compare-delta" + (delta === 0 ? " same" : "")}>
          {delta === 0 ? "件数は同じ" : delta > 0 ? `+${delta}` : String(delta)}
        </span>
        {diff.sameColumns ? (
          <span className="compare-legend">
            <span className="chip removed">消えた {diff.onlyLeft.size}</span>
            <span className="chip added">増えた {diff.onlyRight.size}</span>
          </span>
        ) : (
          <span className="compare-note">
            列の並びが違うため、行の差分は出していません
          </span>
        )}
      </div>

      <div className="compare-panes">
        <div className="compare-pane">
          <div className="compare-head" title={left.sql}>
            <span className="compare-pin" aria-hidden>
              📌
            </span>
            <span className="compare-label">{left.label}</span>
          </div>
          <ResizableGrid
            columns={leftGrid.columns}
            rows={leftGrid.rows}
            maxRenderRows={200}
            emptyText="0行"
          />
        </div>
        <div className="compare-pane">
          <div className="compare-head" title={right.sql}>
            <span className="compare-label">{right.label}</span>
          </div>
          <ResizableGrid
            columns={rightGrid.columns}
            rows={rightGrid.rows}
            maxRenderRows={200}
            emptyText="0行"
          />
        </div>
      </div>
    </div>
  );
}

/** 実行結果を見比べる片側の形に直す (表になる結果だけ) */
export function toComparePane(
  label: string,
  sql: string,
  result: QueryResult
): ComparePane {
  return { label, sql, columns: result.columns, rows: result.rows };
}
