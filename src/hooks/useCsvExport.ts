import { useCallback, useSyncExternalStore } from "react";
import {
  cancelCsvExport,
  csvFromQuery,
  exportPlanCsv,
  exportQueryRows,
  openCsvWindow,
} from "../api";
import {
  clearCsvExportTimer,
  getCsvExport,
  patchCsvExport,
  scheduleCsvExportClear,
  subscribeCsvExport,
} from "../csvExportStore";
import { FORMAT_LABEL } from "../exportFormat";
import type { ExportFormat } from "../exportFormat";
import type { QueryResult } from "../types";

/** 完了メッセージを出しておく時間 */
const MSG_TIMEOUT_MS = 10000;

/** 進捗を出すためのジョブを1つ作る */
function newJob(index: number, verb: string) {
  return {
    id: `csv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    index,
    startedAt: Date.now(),
    verb,
  };
}

/** 出力するSQLとその条件 */
export interface CsvExportRequest {
  sessionId: string;
  database: string | undefined;
  sql: string;
  /** 画面で並び替えているときは、その並びのまま出力する */
  orderBy?: string;
  orderDir?: string;
  /** 進捗と結果を出す結果タブの番号 */
  index: number;
  /** CSV か Excel か */
  format: ExportFormat;
}

/** CSVエディタで開くときの対象 */
export interface CsvEditorRequest {
  sessionId: string;
  database: string | undefined;
  sql: string;
  /** 画面で並び替えているときは、その並びのまま開く */
  orderBy?: string;
  orderDir?: string;
  /** 進捗と結果を出す結果タブの番号 */
  index: number;
  /** タブに出す名前 */
  name: string;
}

/**
 * SQLの結果を全件ファイル (CSV / Excel) へ書き出す。
 *
 * 画面は1000行ずつだが、書き出しは同じSQLを流し直して全行を出力する。
 * 進捗と結果は「出力を始めた結果タブ」でだけ出す (別のタブに出さない)。
 *
 * 状態は `csvExportStore` (画面の外) に置く。
 * 出力中に別のタブへ移ると、このフックを使う画面は一度消えるが、
 * 戻ってきたときに進捗とキャンセルボタンをそのまま出せるようにするため
 *
 * @param key シートを見分けるキー (セッションID + シートID)
 */
export function useCsvExport(key: string) {
  const subscribe = useCallback(
    (fn: () => void) => subscribeCsvExport(key, fn),
    [key]
  );
  const state = useSyncExternalStore(subscribe, () => getCsvExport(key));
  const { job, message, path } = state;

  /** 出力を始める。すでに走っていれば何もしない */
  const start = async (req: CsvExportRequest) => {
    if (getCsvExport(key).job) return;
    const started = newJob(req.index, "出力");
    clearCsvExportTimer(key);
    patchCsvExport(key, { job: started, message: null, path: null });
    const name = FORMAT_LABEL[req.format];
    const show = (text: string) =>
      patchCsvExport(key, { message: { index: started.index, text } });
    try {
      const out = await exportQueryRows(
        req.sessionId,
        req.database,
        req.sql,
        started.id,
        req.format,
        req.orderBy,
        req.orderDir
      );
      if (out.cancelled) {
        show(
          `${name}出力を中止しました (${out.rows.toLocaleString()}行で停止・ファイルは残していません)`
        );
      } else {
        show(`${out.rows.toLocaleString()}行を保存: ${out.path}`);
        patchCsvExport(key, { path: out.path });
      }
      // 続けてもう一度出力したときに、前のタイマーで消されないようにする
      scheduleCsvExportClear(key, MSG_TIMEOUT_MS);
    } catch (e) {
      show(`${name}出力に失敗: ${e}`);
    } finally {
      patchCsvExport(key, { job: null });
    }
  };

  /**
   * 結果を全件取り出して、CSVエディタのタブとして開く。
   *
   * 画面が持っているのは1000行だけなので、書き出しと同じ道を通して流し直す。
   * 大きな結果は時間が掛かるため、進捗とキャンセルは出力と同じ仕組みに乗せる
   */
  const openInEditor = async (req: CsvEditorRequest) => {
    if (getCsvExport(key).job) return;
    const started = newJob(req.index, "取得");
    clearCsvExportTimer(key);
    patchCsvExport(key, { job: started, message: null, path: null });
    const show = (text: string) =>
      patchCsvExport(key, { message: { index: started.index, text } });
    try {
      const out = await csvFromQuery(
        req.sessionId,
        req.database ?? null,
        req.sql,
        req.name,
        started.id,
        req.orderBy,
        req.orderDir
      );
      if (out.cancelled || !out.info) {
        show(
          `取得を中止しました (${out.rows.toLocaleString()}行で停止・開いていません)`
        );
      } else {
        show(`${out.rows.toLocaleString()}行をCSVエディタで開きました`);
        await openCsvWindow({ docId: out.info.docId });
      }
      scheduleCsvExportClear(key, MSG_TIMEOUT_MS);
    } catch (e) {
      show(`CSVエディタで開けませんでした: ${e}`);
    } finally {
      patchCsvExport(key, { job: null });
    }
  };

  /**
   * 画面に出ている実行計画をそのままCSVへ書き出す。
   *
   * 通常の書き出しのようにSQLを流し直すと、
   * `EXPLAIN` の付いていない元のSQLが走って「計画ではなくデータ」が出てしまう。
   * ANALYZE では対象のSQLをもう一度実行することにもなり、
   * 実測時間も画面に出ている値とは別のものになる
   */
  const savePlan = async (result: QueryResult | null, index: number) => {
    if (getCsvExport(key).job || !result) return;
    clearCsvExportTimer(key);
    patchCsvExport(key, { message: null, path: null });
    const show = (text: string) =>
      patchCsvExport(key, { message: { index, text } });
    try {
      const out = await exportPlanCsv(result.columns, result.rows);
      show(`${out.rows.toLocaleString()}行を保存: ${out.path}`);
      patchCsvExport(key, { path: out.path });
      scheduleCsvExportClear(key, MSG_TIMEOUT_MS);
    } catch (e) {
      show(`CSV出力に失敗: ${e}`);
    }
  };

  /** キャンセル要求 (書き出し済みのファイルは破棄される) */
  const cancel = () => {
    const cur = getCsvExport(key).job;
    if (!cur) return;
    cancelCsvExport(cur.id).catch(() => {});
  };

  return { job, message, path, start, openInEditor, savePlan, cancel };
}
