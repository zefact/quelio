/**
 * 取り込む前の下見の結果を、確認ダイアログに出す文章にする。
 *
 * 「列の数が揃っていない行があります」だけでは、2万行の中から
 * 利用者が自力で探すことになる。行番号を例として並べる。
 *
 * 画面から切り離して試せるよう、文章の組み立てだけをここに置く
 */
import type { ShapeReport } from "../../types";

/** 本文に並べる例の数 (多すぎると読めない) */
export const EXAMPLE_LIMIT = 3;

/** 「1234行目 = 38列」の形にする */
function example(m: { lineNo: number; width: number }): string {
  return `${m.lineNo.toLocaleString()}行目 = ${m.width}列`;
}

/** 例の並び (上限を超えた分は「…」にする) */
export function examples(report: ShapeReport): string {
  const shown = report.mismatches.slice(0, EXAMPLE_LIMIT).map(example);
  if (report.mismatchCount > shown.length) shown.push("…");
  return shown.join("、");
}

/** 列ずれがあったか (無ければ確認を出さない) */
export function hasMismatch(report: ShapeReport): boolean {
  return report.mismatchCount > 0;
}

/** 確認ダイアログの本文 */
export function shapeWarningText(report: ShapeReport): string {
  const head = `列の数が揃っていない行が${report.mismatchCount.toLocaleString()}件あります`;
  const note =
    "足りない列は空、余分な列は無視して取り込みます。" +
    "値にカンマや改行が含まれていてクォートされていない可能性があります。";
  const cut = report.truncated
    ? "ファイルが大きいため、途中までしか確かめていません。"
    : "";
  return `${head} (例: ${examples(report)})。${note}${cut}続けますか?`;
}
