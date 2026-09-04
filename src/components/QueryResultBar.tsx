import { CsvProgress } from "./CsvProgress";
import { ExportMenu } from "./ExportMenu";
import { RevealButton } from "./RevealButton";
import type { QueryResult, StatementResult } from "../types";
import { QUERY_PAGE_SIZE } from "../types";
import type { useCsvExport } from "../hooks/useCsvExport";
import type { ExportFormat } from "../exportFormat";
import { isExecResult, statementLabel } from "./queryResult";

interface Props {
  results: StatementResult[];
  activeIdx: number;
  onSelectTab: (index: number) => void;
  /** 表示中の結果タブの結果 */
  result: QueryResult | null;
  running: boolean;
  /** 実行計画を表示中か (書き出す中身と説明が変わる) */
  explainKind: "explain" | "analyze" | null;
  /** 書き出しの状態 (useCsvExport の戻り値) */
  csv: ReturnType<typeof useCsvExport>;
  onExport: (format: ExportFormat) => void;
  /** 結果をCSVエディタで開く */
  onOpenInEditor: () => void;
  /** 件数を数えている最中か */
  counting: boolean;
  /** 数えた総件数 (まだ数えていなければ null) */
  totalRows: number | null;
  onCount: () => void;
  onPage: (index: number, offset: number) => void;
  /** グラフにできるか (表になる結果で、数値の列があるとき) */
  canChart: boolean;
  onOpenChart: () => void;
}

/**
 * 結果ヘッダ: 文ごとのタブ + その文の件数・ページ送り・書き出し。
 * 件数とページ送りは結果タブごとの情報なので結果側に置く
 */
export function QueryResultBar({
  results,
  activeIdx,
  onSelectTab,
  result,
  running,
  explainKind,
  csv,
  onExport,
  onOpenInEditor,
  counting,
  totalRows,
  onCount,
  onPage,
  canChart,
  onOpenChart,
}: Props) {
  return (
    <div className="result-bar">
      {results.length > 1 && (
        <div className="result-tabs">
          {results.map((s, i) => (
            <button
              key={i}
              className={"result-tab" + (i === activeIdx ? " active" : "")}
              title={s.sql}
              onClick={() => onSelectTab(i)}
            >
              {statementLabel(s.sql, i)}
            </button>
          ))}
        </div>
      )}

      {/* 画面の左寄りに並ぶボタンなので、説明は左端を起点に右へ伸ばす
          (既定の右端起点だと、説明の左側が画面の外へ出て読めなくなる) */}
      <div className="result-actions">
        <button
          className="btn-secondary has-tooltip tooltip-wrap tooltip-left"
          data-tooltip={"この結果を棒・折れ線・円グラフで見ます\n(集計クエリの確認用)"}
          disabled={!canChart}
          onClick={onOpenChart}
        >
          グラフ
        </button>
      </div>

      {/* 右側: 書き出し / 件数 / ページ送り (いずれも表示中の結果タブの情報) */}
      <div className="result-bar-right">
        {/* 出力中は進捗 (行数と経過時間) を出し、キャンセルできるようにする。
            進捗も結果メッセージも、出力した結果タブでのみ表示する */}
        {csv.job?.index === activeIdx ? (
          <>
            <CsvProgress
              key={csv.job.id}
              jobId={csv.job.id}
              startedAt={csv.job.startedAt}
              verb={csv.job.verb}
            />
            <button
              className="btn-secondary cancel-query-btn"
              onClick={csv.cancel}
              title="中止する (作りかけのファイルは残しません)"
            >
              キャンセル
            </button>
          </>
        ) : (
          csv.message?.index === activeIdx && (
            <>
              <span className="capture-msg mono" title={csv.message.text}>
                {csv.message.text}
              </span>
              {csv.path && <RevealButton path={csv.path} />}
            </>
          )
        )}

        {!running && result && !isExecResult(result) && (
          <ExportMenu
            disabled={!!csv.job || result.rows.length === 0}
            running={csv.job?.index === activeIdx}
            explainKind={explainKind}
            onRun={(target) =>
              target === "editor" ? onOpenInEditor() : onExport(target)
            }
          />
        )}

        {/*
          ページングで先頭しか出していないときだけ「件数」を出す。
          全部出ていれば数えるまでもない
        */}
        {!running &&
          result &&
          !isExecResult(result) &&
          result.pageable &&
          (result.hasMore || result.offset > 0) &&
          (totalRows === null ? (
            <button
              className="btn-ghost count-rows has-tooltip tooltip-left"
              data-tooltip={"全部で何件あるかを数えます\n(同じ条件で COUNT を1本実行します)"}
              disabled={counting}
              onClick={onCount}
            >
              {counting ? (
                <>
                  <span className="spinner accent" /> 数えています...
                </>
              ) : (
                "件数"
              )}
            </button>
          ) : (
            <span className="query-meta mono total-rows">
              全 {totalRows.toLocaleString()} 件
            </span>
          ))}

        {!running && result && (
          <span className="query-meta mono">
            {isExecResult(result)
              ? `${result.rowsAffected}行に影響`
              : result.pageable
                ? result.rows.length === 0
                  ? "0行"
                  : `${(result.offset + 1).toLocaleString()}〜${(
                      result.offset + result.rows.length
                    ).toLocaleString()}行目`
                : `${result.rows.length}行${result.hasMore ? " (先頭のみ表示)" : ""}`}
            {` — ${result.elapsedMs}ms`}
          </span>
        )}

        {result?.pageable && (result.offset > 0 || result.hasMore) && (
          <span className="pager">
            <button
              className="pager-btn"
              title="前の1000行"
              disabled={running || result.offset === 0}
              onClick={() =>
                onPage(activeIdx, Math.max(0, result.offset - QUERY_PAGE_SIZE))
              }
            >
              ‹
            </button>
            <button
              className="pager-btn"
              title="次の1000行"
              disabled={running || !result.hasMore}
              onClick={() => onPage(activeIdx, result.offset + QUERY_PAGE_SIZE)}
            >
              ›
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
