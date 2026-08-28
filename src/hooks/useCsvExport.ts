import { useEffect, useRef, useState } from "react";
import { cancelCsvExport, exportPlanCsv, exportQueryCsv } from "../api";
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
 * 進捗と結果は「出力を始めた結果タブ」でだけ出す (別のタブに出さない)
 */
export function useCsvExport() {
  /** 出力中のジョブ (対象の結果タブ・ID・開始時刻。未実行はnull) */
  const [job, setJob] = useState<{
    id: string;
    index: number;
    startedAt: number;
  } | null>(null);
  /** 結果メッセージ (出力した結果タブでのみ表示する) */
  const [message, setMessage] = useState<{
    index: number;
    text: string;
  } | null>(null);
  /** 保存先 (「フォルダを開く」用) */
  const [path, setPath] = useState<string | null>(null);

  /** 完了メッセージを消すタイマー */
  const msgTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (msgTimer.current) window.clearTimeout(msgTimer.current);
    },
    []
  );

  /** 出力を始める。すでに走っていれば何もしない */
  const start = async (req: CsvExportRequest) => {
    if (job) return;
    const started = {
      id: `csv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      index: req.index,
      startedAt: Date.now(),
    };
    setJob(started);
    setMessage(null);
    setPath(null);
    if (msgTimer.current) window.clearTimeout(msgTimer.current);
    const show = (text: string) => setMessage({ index: started.index, text });
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
        setPath(out.path);
      }
      // 続けてもう一度出力したときに、前のタイマーで消されないようにする
      if (msgTimer.current) window.clearTimeout(msgTimer.current);
      msgTimer.current = window.setTimeout(() => {
        setMessage(null);
        setPath(null);
      }, MSG_TIMEOUT_MS);
    } catch (e) {
      show(`CSV出力に失敗: ${e}`);
    } finally {
      setJob(null);
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
    if (job || !result) return;
    setMessage(null);
    setPath(null);
    if (msgTimer.current) window.clearTimeout(msgTimer.current);
    const show = (text: string) => setMessage({ index, text });
    try {
      const out = await exportPlanCsv(result.columns, result.rows);
      show(`${out.rows.toLocaleString()}行を保存: ${out.path}`);
      setPath(out.path);
      msgTimer.current = window.setTimeout(() => {
        setMessage(null);
        setPath(null);
      }, MSG_TIMEOUT_MS);
    } catch (e) {
      show(`CSV出力に失敗: ${e}`);
    }
  };

  /** キャンセル要求 (書き出し済みのファイルは破棄される) */
  const cancel = () => {
    if (!job) return;
    cancelCsvExport(job.id).catch(() => {});
  };

  return { job, message, path, start, savePlan, cancel };
}
