import { useMemo } from "react";
import type { QueryResult } from "../types";
import { QUERY_PAGE_SIZE } from "../types";
import {
  GridColumn,
  ResizableGrid,
  SortDir,
  SortState,
} from "./ResizableGrid";

interface Props {
  /** 取得済みの1ページぶんのデータ (未取得はnull) */
  data: QueryResult | null;
  loading: boolean;
  error: string | null;
  /** 絞り込み条件 (WHERE句。空なら全件) */
  where: string;
  /** 行番号列を表示するか (設定値) */
  showRowNumbers: boolean;
  /** カラム名(小文字) → 論理名・補足・型の説明 (ヘッダのツールチップ用) */
  columnTips: Record<string, string>;
  onChangeWhere: (where: string) => void;
  /** 絞り込みを適用して先頭ページから取得し直す */
  onApplyWhere: () => void;
  /** 表示中のページを取得し直す */
  onReload: () => void;
  onPage: (offset: number) => void;
  onSort: (orderBy: string | null, orderDir: "asc" | "desc") => void;
}

/** 選択テーブルのデータ表示 (1000件ごとのページング + サーバーサイドソート) */
export function TableDataView({
  data,
  loading,
  error,
  where,
  showRowNumbers,
  columnTips,
  onChangeWhere,
  onApplyWhere,
  onReload,
  onPage,
  onSort,
}: Props) {
  const columns: GridColumn[] = useMemo(() => {
    const cols: GridColumn[] = (data?.columns ?? []).map((name, i) => ({
      id: `c${i}`,
      label: name,
      width: Math.min(260, Math.max(90, name.length * 10 + 40)),
      minWidth: 60,
      // 定義から読み取った論理名・補足をヘッダのツールチップに出す
      description: columnTips[name.toLowerCase()],
    }));
    if (showRowNumbers && cols.length > 0) {
      // 表示中の最大行番号に合わせて幅を決める
      const maxNum = (data?.offset ?? 0) + (data?.rows.length ?? 0);
      cols.unshift({
        id: "__row",
        label: "行",
        width: Math.max(58, String(maxNum).length * 9 + 36),
        minWidth: 46,
        align: "right",
        cellClass: "rownum-cell",
        sortable: false,
        excludeFromCopy: true,
        description: "行番号 (取得結果の通し番号。データの値ではありません)",
      });
    }
    return cols;
  }, [data, showRowNumbers, columnTips]);

  /** グリッドに表示するソート状態 (サーバーサイドソートの結果をそのまま反映) */
  const sort: SortState | null = useMemo(() => {
    if (!data?.orderBy) return null;
    const idx = data.columns.indexOf(data.orderBy);
    if (idx < 0) return null;
    return { id: `c${idx}`, dir: data.orderDir === "desc" ? "desc" : "asc" };
  }, [data]);

  /** ヘッダのソートメニューでの選択 (サーバーサイドソートで再取得する) */
  const selectSort = (id: string, dir: SortDir) => {
    if (id === "__row" || loading || !data) return;
    const colName = data.columns[Number(id.slice(1))];
    if (!colName) return;
    onSort(dir ? colName : null, dir ?? "asc");
  };

  const offset = data?.offset ?? 0;

  /** 列幅の自動フィットをやり直す条件 (取得内容が変わったときだけ測り直す) */
  const fitKey = useMemo(
    () =>
      data
        ? [
            data.columns.join("␟"),
            data.offset,
            data.rows.length,
            data.orderBy ?? "",
            data.orderDir ?? "",
          ].join("|")
        : "",
    [data]
  );

  return (
    <div className="table-data">
      {/* 絞り込み + ページ操作 */}
      <div className="query-actions table-data-actions">
        <input
          className="filter-input mono table-where"
          placeholder="絞り込み条件 (WHERE句。例: status = 1 AND name LIKE '%山%')"
          value={where}
          onChange={(e) => onChangeWhere(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onApplyWhere();
          }}
        />
        <button
          className="btn-primary"
          onClick={onApplyWhere}
          disabled={loading}
          title="条件を適用して先頭ページから取得し直す (Enter)"
        >
          {loading ? (
            <>
              <span className="spinner light" /> 取得中...
            </>
          ) : (
            "適用"
          )}
        </button>
        <button
          className="btn-secondary explain-btn"
          onClick={onReload}
          disabled={loading}
          title="表示中のページを取得し直す"
        >
          再読込
        </button>

        {!loading && data && (
          <span className="query-meta mono">
            {data.rows.length === 0
              ? "0行"
              : `${(offset + 1).toLocaleString()}〜${(
                  offset + data.rows.length
                ).toLocaleString()}行目`}
            {` — ${data.elapsedMs}ms`}
          </span>
        )}

        {data && (offset > 0 || data.hasMore) && (
          <span className="pager">
            <button
              className="pager-btn"
              title="前の1000行"
              disabled={loading || offset === 0}
              onClick={() => onPage(Math.max(0, offset - QUERY_PAGE_SIZE))}
            >
              ‹
            </button>
            <button
              className="pager-btn"
              title="次の1000行"
              disabled={loading || !data.hasMore}
              onClick={() => onPage(offset + QUERY_PAGE_SIZE)}
            >
              ›
            </button>
          </span>
        )}
      </div>

      {error && (
        <div className="result-banner ng query-error">
          <span className="dot" aria-hidden />
          <strong>エラー</strong>
          <span className="result-detail">{error}</span>
        </div>
      )}

      <div className="table-data-grid">
        {loading && !data ? (
          <div className="content-placeholder dim-center">
            <span className="spinner accent" /> データを読み込み中...
          </div>
        ) : !data ? (
          !error && (
            <div className="content-placeholder dim-center">
              データがありません
            </div>
          )
        ) : data.rows.length === 0 ? (
          <div className="content-placeholder dim-center">
            該当するデータはありません
          </div>
        ) : (
          <ResizableGrid
            autoFit
            fitKey={fitKey}
            selectable
            columns={columns}
            sort={sort}
            onSortSelect={selectSort}
            rows={data.rows.map((cells, index) => {
              const nodes = cells.map((v) =>
                v === null ? (
                  <span className="null-cell">NULL</span>
                ) : (
                  <span className="mono" title={v}>
                    {v}
                  </span>
                )
              );
              if (showRowNumbers) {
                nodes.unshift(
                  <span className="mono row-num">{offset + index + 1}</span>
                );
              }
              return { key: String(index), cells: nodes };
            })}
          />
        )}
      </div>
    </div>
  );
}
