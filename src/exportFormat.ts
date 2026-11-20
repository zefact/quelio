/**
 * 結果の書き出し形式 (CSV / Excel)。
 *
 * 形式は人によって決まっている (経理へ渡すならExcel、機械にかけるならCSV) ので、
 * 毎回選ばせず、前に選んだものを次の既定にする
 */

export type ExportFormat = "csv" | "xlsx";

/**
 * 結果の書き出し先。
 *
 * ファイルに書き出す2つに加えて、CSVエディタで開くのも同じ場所から選ぶ
 * (どれも「結果を全件どこかへ持っていく」操作なので)
 */
export type ExportTarget = ExportFormat | "editor";

/** 画面に出す名前 */
export const FORMAT_LABEL: Record<ExportFormat, string> = {
  csv: "CSV",
  xlsx: "Excel",
};

/**
 * ボタンに出す名前 (選んでいる書き出し先がそのままボタンになる)。
 * 「ダウンロード」はネットから落とすように読めるので使わない
 */
export const TARGET_LABEL: Record<ExportTarget, string> = {
  csv: "CSV で書き出す",
  xlsx: "Excel で書き出す",
  editor: "CSVエディタで開く",
};

/** 選んだ書き出し先を覚えておく場所 */
const KEY = "quelio.exportFormat";

/** 前に選んだ書き出し先 (初めてならCSV) */
export function lastExportTarget(): ExportTarget {
  try {
    const v = localStorage.getItem(KEY);
    return v === "xlsx" || v === "editor" ? v : "csv";
  } catch {
    // プライベートウィンドウなどで読めないことがある。既定に落とすだけでよい
    return "csv";
  }
}

/** 選んだ書き出し先を覚える */
export function rememberExportTarget(target: ExportTarget): void {
  try {
    localStorage.setItem(KEY, target);
  } catch {
    // 覚えられなくても書き出し自体はできるので、何もしない
  }
}
