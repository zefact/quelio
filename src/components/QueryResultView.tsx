import { memo } from "react";
import { isPlanResult, planLines, PlanView } from "./PlanView";
import {
  GridColumn,
  GridRow,
  ResizableGrid,
  SortDir,
  SortState,
} from "./ResizableGrid";
import type { QueryResult } from "../types";
import { isExecResult } from "./queryResult";

interface Props {
  /** 表示中の結果タブの結果 (未実行はnull) */
  result: QueryResult | null;
  error: string | null;
  columns: GridColumn[];
  rows: GridRow[];
  /** 値が切り詰められている行のキー (コピーの注記に使う) */
  clippedRowKeys: Set<string>;
  sort: SortState | null;
  onSortSelect: (id: string, dir: SortDir) => void;
  /** 列幅を測り直す目印 (実行時刻:結果タブ) */
  fitKey: string;
}

/**
 * SQLの実行結果の表示 (エラー / 実行完了 / 実行計画 / 表)。
 *
 * 200行ぶんのDOMを作るので、結果が変わっていないときは描き直さない
 * (エディタの高さ調整・CSVの進捗などで親が何度も描き直されるため)
 */
function QueryResultViewInner({
  result,
  error,
  columns,
  rows,
  clippedRowKeys,
  sort,
  onSortSelect,
  fitKey,
}: Props) {
  return (
    <div className="query-result">
      {error && (
        <div className="result-banner ng query-error">
          <span className="dot" aria-hidden />
          <strong>エラー</strong>
          <span className="result-detail">{error}</span>
        </div>
      )}
      {!result ? (
        !error && (
          <div className="content-placeholder dim-center">
            SQLを実行すると結果がここに表示されます
          </div>
        )
      ) : isExecResult(result) ? (
        <div className="result-banner ok exec-result">
          <span className="dot" aria-hidden />
          <strong>実行完了</strong>
          <span className="result-detail">
            {result.rowsAffected}行に影響しました ({result.elapsedMs}ms)
          </span>
        </div>
      ) : result.rows.length === 0 ? (
        <div className="content-placeholder dim-center">結果は0行でした</div>
      ) : isPlanResult(result.columns) ? (
        <PlanView lines={planLines(result.rows)} />
      ) : (
        <ResizableGrid
          // 実行のたび・結果タブの切替のたびに列幅を内容へフィットさせる
          autoFit
          fitKey={fitKey}
          selectable
          columns={columns}
          sort={sort}
          onSortSelect={onSortSelect}
          rows={rows}
          clippedRowKeys={clippedRowKeys}
          // まず200行だけ描き、スクロールに合わせて継ぎ足す
          maxRenderRows={200}
        />
      )}
    </div>
  );
}

export const QueryResultView = memo(QueryResultViewInner);
