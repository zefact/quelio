import { CsvProgress } from "./CsvProgress";
import { ExportMenu } from "./ExportMenu";
import { RevealButton } from "./RevealButton";
import type { QueryResult, StatementResult } from "../types";
import type { useCsvExport } from "../hooks/useCsvExport";
import type { ExportFormat } from "../exportFormat";
import { isExecResult, statementLabel } from "./queryResult";
import { ResultBar } from "./ResultBar";
import type { ResultRange } from "../resultRange";
import type { HeaderLabelMode } from "../types";

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
  /** ヘッダに出す名前 (英語名 / 日本語名 / 両方) */
  headerMode: HeaderLabelMode;
  onChangeHeaderMode: (mode: HeaderLabelMode) => void;
}

/** SQLの結果は編集できないことの説明 (「閲覧のみ」の印に出す) */
const READ_ONLY_REASON =
  "SQLの結果はここでは編集できません\n" +
  "行を直すときは、テーブルの「データ」タブか UPDATE 文を使ってください";

/** 結果の件数の出し方 (表にならない文 / ページで取った表 / それ以外の表) */
function rangeOf(result: QueryResult): ResultRange {
  if (isExecResult(result)) {
    return { kind: "exec", affected: result.rowsAffected ?? 0 };
  }
  return result.pageable
    ? { kind: "page", offset: result.offset, rows: result.rows.length }
    : { kind: "head", rows: result.rows.length, more: result.hasMore };
}

/**
 * SQL結果の結果バー: 文ごとのタブ + その文の件数・ページ送り・書き出し。
 * 件数とページ送りは結果タブごとの情報なので結果側に置く。
 * 並び順と見た目はデータタブと共通 (ResultBar)
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
  headerMode,
  onChangeHeaderMode,
}: Props) {
  /** 表になる結果を出し終えているか (列名の切り替え・書き出し・閲覧のみ はこのときだけ) */
  const table = !running && !!result && !isExecResult(result);

  return (
    <ResultBar
      lead={
        results.length > 1 && (
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
        )
      }
      header={table ? { mode: headerMode, onChange: onChangeHeaderMode } : undefined}
      tools={
        /* 画面の左寄りに並ぶボタンなので、説明は左端を起点に右へ伸ばす
           (既定の右端起点だと、説明の左側が画面の外へ出て読めなくなる) */
        <button
          className="btn-secondary has-tooltip tooltip-wrap tooltip-left"
          data-tooltip={"この結果を棒・折れ線・円グラフで見ます\n(集計クエリの確認用)"}
          disabled={!canChart}
          onClick={onOpenChart}
        >
          グラフ
        </button>
      }
      /*
        SQLの結果は編集できない (どの行か特定できるとは限らないため)。
        データタブで「行を追加」などが出る位置に、そう書いておく
      */
      readOnly={table ? READ_ONLY_REASON : null}
      output={
        <>
          {/* 書き出し中は進捗 (行数と経過時間) を出し、中止できるようにする。
              進捗も結果メッセージも、書き出した結果タブでのみ表示する */}
          {csv.job?.index === activeIdx ? (
            <>
              <CsvProgress
                key={csv.job.id}
                jobId={csv.job.id}
                startedAt={csv.job.startedAt}
                verb={csv.job.verb}
              />
              <button
                className="btn-secondary cancel-query-btn has-tooltip"
                onClick={csv.cancel}
                data-tooltip="書き出しを中止します (作りかけのファイルは残しません)"
              >
                中止
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

          {table && (
            <ExportMenu
              disabled={!!csv.job || result.rows.length === 0}
              running={csv.job?.index === activeIdx}
              explainKind={explainKind}
              onRun={(target) =>
                target === "editor" ? onOpenInEditor() : onExport(target)
              }
            />
          )}
        </>
      }
      total={
        /*
          ページングで先頭しか出していないときだけ「行数」を出す。
          全部出ていれば数えるまでもない
        */
        table &&
        result.pageable &&
        (result.hasMore || result.offset > 0) &&
        (totalRows === null ? (
          <button
            className="btn-ghost count-rows has-tooltip"
            data-tooltip={"全部で何行あるかを数えます\n(同じ条件で COUNT を1本実行します)"}
            disabled={counting}
            onClick={onCount}
          >
            {counting ? (
              <>
                <span className="spinner accent" /> 数えています…
              </>
            ) : (
              "行数"
            )}
          </button>
        ) : (
          <span className="query-meta mono total-rows">
            全 {totalRows.toLocaleString()} 行
          </span>
        ))
      }
      meta={
        !running && result
          ? { range: rangeOf(result), elapsedMs: result.elapsedMs }
          : null
      }
      page={
        result?.pageable
          ? {
              offset: result.offset,
              hasMore: result.hasMore,
              disabled: running,
              onPage: (offset) => onPage(activeIdx, offset),
            }
          : null
      }
    />
  );
}
