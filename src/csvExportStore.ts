/**
 * CSV出力の進行状況を、画面の外に置いておくための入れ物。
 *
 * タブを切り替えるとSQLパネルはいったん外れるため、
 * Reactのstateだけで持っていると、戻ってきたときに進捗もキャンセルボタンも
 * 消えてしまう (出力自体は裏で続いているのに、止める手段が無くなる)。
 * シートごとに状態をここへ置き、画面はそれを見に来るだけにする
 */
import { createKeyedStore } from "./keyedStore";

/** 出力中のジョブ (対象の結果タブ・ID・開始時刻) */
export interface CsvExportJob {
  id: string;
  /** 進捗を出す結果タブの番号 */
  index: number;
  startedAt: number;
  /** 進捗に出す動作の名前 (ファイルへ出すなら「出力」、取り出すなら「取得」) */
  verb: string;
}

/** 結果メッセージ (出力した結果タブでのみ表示する) */
export interface CsvExportMessage {
  index: number;
  text: string;
}

/** 1シート分のCSV出力の状態 */
export interface CsvExportState {
  /** 出力中でなければ null */
  job: CsvExportJob | null;
  message: CsvExportMessage | null;
  /** 保存先 (「フォルダを開く」用) */
  path: string | null;
}

/** 何も無い状態 */
export const EMPTY_CSV_EXPORT: CsvExportState = {
  job: null,
  message: null,
  path: null,
};

export const csvExportStore = createKeyedStore(EMPTY_CSV_EXPORT);

/** シートのキー → 完了メッセージを消すタイマー */
const timers = new Map<string, number>();

/** 今の状態を取り出す */
export function getCsvExport(key: string): CsvExportState {
  return csvExportStore.get(key);
}

/** 一部だけ書き換えて、見ている画面へ知らせる */
export function patchCsvExport(
  key: string,
  patch: Partial<CsvExportState>
): void {
  csvExportStore.patch(key, patch);
}

/** 変化を受け取る (戻り値を呼ぶと解除) */
export function subscribeCsvExport(key: string, fn: () => void): () => void {
  return csvExportStore.subscribe(key, fn);
}

/**
 * 完了メッセージを一定時間で消す予約をする。
 *
 * タイマーも画面の外に置く。画面と一緒に消してしまうと、
 * タブを離れている間に終わった出力のメッセージが残り続ける
 */
export function scheduleCsvExportClear(key: string, ms: number): void {
  clearCsvExportTimer(key);
  const id = window.setTimeout(() => {
    timers.delete(key);
    patchCsvExport(key, { message: null, path: null });
  }, ms);
  timers.set(key, id);
}

/** 予約済みの「メッセージを消す」を取り消す */
export function clearCsvExportTimer(key: string): void {
  const id = timers.get(key);
  if (id !== undefined) {
    window.clearTimeout(id);
    timers.delete(key);
  }
}

/** シートやタブを閉じたときの後始末 */
export function dropCsvExport(key: string): void {
  clearCsvExportTimer(key);
  csvExportStore.drop(key);
}

/** テスト用: すべて捨てる */
export function resetCsvExportStore(): void {
  timers.forEach((id) => window.clearTimeout(id));
  timers.clear();
  csvExportStore.reset();
}
