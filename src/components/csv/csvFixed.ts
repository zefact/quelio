/**
 * 固定長の桁まわりの小道具。
 *
 * 桁の並びは「10,8,20,4」のような文字でやり取りするのが速いので、
 * その読み書きと、画面に出す言葉をここにまとめる
 */
import type { CsvFixedColumn, CsvFixedLayout, CsvWidthUnit } from "../../types";

/** 桁の数え方の呼び名 */
export const UNIT_LABEL: Record<CsvWidthUnit, string> = {
  byte: "バイト",
  char: "文字",
};

/** 桁1つを作る (左寄せ・空白埋め) */
export function newColumn(width: number): CsvFixedColumn {
  return { width, align: "left", pad: " ", name: "" };
}

/** 「10,8,20」のような文字を幅の並びにする (数でないものは捨てる) */
export function parseWidths(text: string): number[] {
  return text
    .split(/[,\s、]+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** 幅の並びを「10,8,20」の形にする */
export function widthsText(columns: CsvFixedColumn[]): string {
  return columns.map((c) => c.width).join(",");
}

/** 桁の合計 (1行の長さ) */
export function totalWidth(columns: CsvFixedColumn[]): number {
  return columns.reduce((a, c) => a + c.width, 0);
}

/**
 * 幅の並びを今のレイアウトへ流し込む。
 *
 * 同じ位置の桁は詰め方と項目名をそのまま残す
 * (幅だけ直したいときに、名前を付け直さずに済むように)
 */
export function applyWidths(
  layout: CsvFixedLayout,
  widths: number[]
): CsvFixedLayout {
  return {
    ...layout,
    columns: widths.map((w, i) => {
      const old = layout.columns[i];
      return old ? { ...old, width: w } : newColumn(w);
    }),
  };
}

/** 形の1行まとめに出す固定長の説明 */
export function fixedLabel(layout: CsvFixedLayout): string {
  const n = layout.columns.length;
  const total = totalWidth(layout.columns);
  return `固定長 ${n}桁 (計${total}${UNIT_LABEL[layout.unit]})`;
}
