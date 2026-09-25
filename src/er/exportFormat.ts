/**
 * ER図の書き出し形式 (Excel / PNG / SVG / Mermaid / PlantUML)。
 *
 * 使う形式は人によってほぼ決まっているので、毎回選ばせず、
 * 前に選んだものを次の既定にする (結果の書き出しボタンと同じ考え方)
 */

export type ErExportFormat = "xlsx" | "png" | "svg" | "mermaid" | "plantuml";

/** テキストとして出せる形式 (クリップボードへもコピーできる) */
export type ErTextFormat = "svg" | "mermaid" | "plantuml";

/** 選べる形式 (並び順はそのままメニューの並びになる) */
export const ER_FORMATS: readonly {
  value: ErExportFormat;
  label: string;
  note: string;
}[] = [
  { value: "xlsx", label: "Excel", note: "図形で描く。Excel上で動かせる" },
  { value: "png", label: "PNG", note: "画像。資料やチャットに貼る" },
  { value: "svg", label: "SVG", note: "拡大しても崩れない画像" },
  { value: "mermaid", label: "Mermaid", note: "GitHub・Notionがそのまま図にする" },
  { value: "plantuml", label: "PlantUML", note: "テキストで図を管理する" },
];

/** 画面に出す形式名 */
export function formatLabel(f: ErExportFormat): string {
  return ER_FORMATS.find((x) => x.value === f)?.label ?? f;
}

/** クリップボードへコピーできる形式か */
export function isTextFormat(f: ErExportFormat): f is ErTextFormat {
  return f === "svg" || f === "mermaid" || f === "plantuml";
}

/** 選んだ形式を覚えておく場所 */
const KEY = "quelio.erExportFormat";

/** 前に選んだ形式 (初めて・読めないときはPNG) */
export function lastErFormat(): ErExportFormat {
  try {
    const v = localStorage.getItem(KEY);
    return ER_FORMATS.some((f) => f.value === v) ? (v as ErExportFormat) : "png";
  } catch {
    // 読めなくても既定に落とすだけでよい
    return "png";
  }
}

/** 選んだ形式を覚える */
export function rememberErFormat(f: ErExportFormat): void {
  try {
    localStorage.setItem(KEY, f);
  } catch {
    // 覚えられなくても書き出し自体はできるので、何もしない
  }
}
