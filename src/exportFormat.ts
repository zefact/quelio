/**
 * 結果の書き出し形式 (CSV / Excel)。
 *
 * 形式は人によって決まっている (経理へ渡すならExcel、機械にかけるならCSV) ので、
 * 毎回選ばせず、前に選んだものを次の既定にする
 */

export type ExportFormat = "csv" | "xlsx";

/** 画面に出す名前 */
export const FORMAT_LABEL: Record<ExportFormat, string> = {
  csv: "CSV",
  xlsx: "Excel",
};

/** 選んだ形式を覚えておく場所 */
const KEY = "quelio.exportFormat";

/** 前に選んだ形式 (初めてならCSV) */
export function lastExportFormat(): ExportFormat {
  try {
    return localStorage.getItem(KEY) === "xlsx" ? "xlsx" : "csv";
  } catch {
    // プライベートウィンドウなどで読めないことがある。既定に落とすだけでよい
    return "csv";
  }
}

/** 選んだ形式を覚える */
export function rememberExportFormat(format: ExportFormat): void {
  try {
    localStorage.setItem(KEY, format);
  } catch {
    // 覚えられなくても書き出し自体はできるので、何もしない
  }
}
