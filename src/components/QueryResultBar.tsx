import { CsvProgress } from "./CsvProgress";
import { RevealButton } from "./RevealButton";
import type { QueryResult, StatementResult } from "../types";
import { QUERY_PAGE_SIZE } from "../types";
import type { useCsvExport } from "../hooks/useCsvExport";
import { isExecResult, statementLabel } from "./queryResult";

interface Props {
  results: StatementResult[];
  activeIdx: number;
  onSelectTab: (index: number) => void;
  /** 表示中の結果タブの結果 */
  result: QueryResult | null;
  running: boolean;
  /** 実行計画を表示中か (CSVの中身と説明が変わる) */
  explainKind: "explain" | "analyze" | null;
  /** CSV出力の状態 (useCsvExport の戻り値) */
  csv: ReturnType<typeof useCsvExport>;
  onExportCsv: () => void;
  onPage: (index: number, offset: number) => void;
  /** ピン留めできるか (表になる結果のときだけ) */
  canPin: boolean;
  /** ピン留め中の見出し (していなければnull) */
  pinnedLabel: string | null;
  /** 見比べ中か */
  comparing: boolean;
  onPin: () => void;
  onUnpin: () => void;
  onToggleCompare: () => void;
  /** グラフにできるか (表になる結果で、数値の列があるとき) */
  canChart: boolean;
  onOpenChart: () => void;
}

/**
 * 結果ヘッダ: 文ごとのタブ + その文の件数・ページ送り・CSV出力。
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
  onExportCsv,
  onPage,
  canPin,
  pinnedLabel,
  comparing,
  onPin,
  onUnpin,
  onToggleCompare,
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

      {/* 結果を取っておいて次の実行結果と見比べる。
          画面の左寄りに並ぶボタンなので、説明は左端を起点に右へ伸ばす
          (既定の右端起点だと、説明の左側が画面の外へ出て読めなくなる) */}
      <div className="result-pin">
        <button
          className="btn-secondary pin-btn has-tooltip tooltip-wrap tooltip-left"
          data-tooltip={"この結果を棒・折れ線・円グラフで見ます\n(集計クエリの確認用)"}
          disabled={!canChart}
          onClick={onOpenChart}
        >
          グラフ
        </button>
        {pinnedLabel === null ? (
          <button
            className="btn-secondary pin-btn has-tooltip tooltip-wrap tooltip-left"
            data-tooltip={"この結果を取っておきます\n次に実行した結果と並べて見比べられます"}
            disabled={!canPin}
            onClick={onPin}
          >
            結果をピン留め
          </button>
        ) : (
          <>
            <span className="pinned-chip mono" title={pinnedLabel}>
              📌 {pinnedLabel}
            </span>
            <button
              className={"btn-secondary pin-btn" + (comparing ? " on" : "")}
              disabled={!canPin}
              title="ピン留めした結果と、今の結果を横に並べます"
              onClick={onToggleCompare}
            >
              {comparing ? "比較をやめる" : "比較"}
            </button>
            <button
              className="btn-ghost pin-btn"
              title="ピン留めを解除する"
              onClick={onUnpin}
            >
              ✕
            </button>
          </>
        )}
      </div>

      {/* 右側: CSV出力 / 件数 / ページ送り (いずれも表示中の結果タブの情報) */}
      <div className="result-bar-right">
        {/* 出力中は進捗 (行数と経過時間) を出し、キャンセルできるようにする。
            進捗も結果メッセージも、出力した結果タブでのみ表示する */}
        {csv.job?.index === activeIdx ? (
          <>
            <CsvProgress
              key={csv.job.id}
              jobId={csv.job.id}
              startedAt={csv.job.startedAt}
            />
            <button
              className="btn-secondary cancel-query-btn"
              onClick={csv.cancel}
              title="CSV出力を中止する (作りかけのファイルは残しません)"
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
          <button
            // 画面右端のボタンなので、ツールチップは右端起点で左へ伸ばす
            // (tooltip-leftを付けると右へ伸びて画面外で切れる)
            className="btn-secondary explain-btn csv-btn has-tooltip tooltip-wrap"
            data-tooltip={
              explainKind
                ? "画面に出ている実行計画をCSVで保存します\n(SQLは実行し直しません)"
                : "この結果タブのSQLを全件CSVで保存します\n1000行を超えても全行出力します"
            }
            disabled={!!csv.job || result.rows.length === 0}
            onClick={onExportCsv}
          >
            {csv.job?.index === activeIdx ? (
              <>
                <span className="spinner accent" /> 出力中...
              </>
            ) : (
              "CSVダウンロード"
            )}
          </button>
        )}

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
