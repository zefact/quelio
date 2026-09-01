/**
 * CSV取り込みの画面の状態を、接続タブごとに画面の外へ置いておく入れ物。
 *
 * 取り込みの画面は接続タブで共用しているため、タブを切り替えると
 * 閉じたのと同じ状態になってしまう。取り込み中だと、裏では処理が続いているのに
 * 進捗も中止ボタンも見えなくなる (＝止められない) ので、
 * タブごとに状態をここへ置き、戻ってきたら続きを出せるようにする。
 *
 * 先頭の読み取り結果 (プレビュー) と取り込み先の列は、
 * ファイル・テーブルから取り直せるので画面側に置いたままにする
 */
import { createKeyedStore } from "./keyedStore";
import type { PickedFile } from "./components/csvImport/CsvFilePicker";
import type { CsvOptions, ImportMode, TableInfo } from "./types";

/** 実行中の取り込み */
export interface CsvImportJob {
  id: string;
  startedAt: number;
}

/** 画面で選んだ内容 (取り直せないので預ける) */
export interface CsvImportForm {
  file: PickedFile | null;
  options: CsvOptions;
  mode: ImportMode;
  /** 空欄をNULLとして入れるか */
  emptyAsNull: boolean;
  /** ファイルの列 → 取り込み先の列 */
  mapping: (string | null)[];
  /**
   * 自動で割り当てたときの「ファイルと列の並び」。
   * 同じならもう一度自動で割り当てない (手で直した対応を消さないため)
   */
  mappedFor: string | null;
  /** 取り込み済みか (同じ内容を続けて2回入れてしまわないように) */
  imported: boolean;
}

/** 1タブ分のCSV取り込みの状態 */
export interface CsvImportState {
  /** 取り込み先のテーブル (nullなら画面を出していない) */
  target: TableInfo | null;
  form: CsvImportForm;
  /** 実行中でなければ null */
  job: CsvImportJob | null;
  /** 中止を要求済みか (二重に押させない) */
  cancelling: boolean;
  /** 終わったときの表示 */
  result: string | null;
  error: string | null;
}

/** 選ぶ前のフォーム */
export const EMPTY_CSV_IMPORT_FORM: CsvImportForm = {
  file: null,
  options: { hasHeader: true },
  mode: "append",
  emptyAsNull: true,
  mapping: [],
  mappedFor: null,
  imported: false,
};

/** 画面を出していない状態 */
export const EMPTY_CSV_IMPORT: CsvImportState = {
  target: null,
  form: EMPTY_CSV_IMPORT_FORM,
  job: null,
  cancelling: false,
  result: null,
  error: null,
};

export const csvImportStore = createKeyedStore(EMPTY_CSV_IMPORT);

/** 取り込みの画面を開く (前回の内容は引きずらない) */
export function openCsvImport(key: string, target: TableInfo): void {
  csvImportStore.patch(key, {
    ...EMPTY_CSV_IMPORT,
    target,
  });
}

/**
 * 取り込みの画面を閉じる。
 * 実行中は閉じない (裏で続いている処理を見失わないため)
 */
export function closeCsvImport(key: string): void {
  if (csvImportStore.get(key).job) return;
  csvImportStore.drop(key);
}

/** フォームの一部を書き換える */
export function patchCsvImportForm(
  key: string,
  patch: Partial<CsvImportForm>
): void {
  csvImportStore.patch(key, {
    form: { ...csvImportStore.get(key).form, ...patch },
  });
}
