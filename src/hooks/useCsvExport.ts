import { useCallback, useSyncExternalStore } from "react";
import { cancelCsvExport, exportPlanCsv, exportQueryCsv } from "../api";
import {
  clearCsvExportTimer,
  getCsvExport,
  patchCsvExport,
  scheduleCsvExportClear,
  subscribeCsvExport,
} from "../csvExportStore";
import type { QueryResult } from "../types";

/** 完了メッセージを出しておく時間 */
const MSG_TIMEOUT_MS = 10000;

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
}

/**
 * SQLの結果を全件CSVへ書き出す。
 *
 * 画面は1000行ずつだが、CSVは同じSQLを流し直して全行を出力する。
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
    const started = {
      id: `csv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      index: req.index,
      startedAt: Date.now(),
    };
    clearCsvExportTimer(key);
    patchCsvExport(key, { job: started, message: null, path: null });
    const show = (text: string) =>
      patchCsvExport(key, { message: { index: started.index, text } });
    try {
      const out = await exportQueryCsv(
        req.sessionId,
        req.database,
        req.sql,
        started.id,
        req.orderBy,
        req.orderDir
      );
      if (out.cancelled) {
        show(
          `CSV出力を中止しました (${out.rows.toLocaleString()}行で停止・ファイルは残していません)`
        );
      } else {
        show(`${out.rows.toLocaleString()}行を保存: ${out.path}`);
        patchCsvExport(key, { path: out.path });
      }
      // 続けてもう一度出力したときに、前のタイマーで消されないようにする
      scheduleCsvExportClear(key, MSG_TIMEOUT_MS);
    } catch (e) {
      show(`CSV出力に失敗: ${e}`);
    } finally {
      patchCsvExport(key, { job: null });
    }
  };

  /**
   * 画面に出ている実行計画をそのままCSVへ書き出す。
   *
   * 通常のCSV出力のようにSQLを流し直すと、
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

  return { job, message, path, start, savePlan, cancel };
}
