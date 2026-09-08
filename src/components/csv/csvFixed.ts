/**
 * 固定長の桁まわりの小道具。
 *
 * 桁の並びは「10,8,20,4」のような文字でやり取りするのが速いので、
 * その読み書きと、画面に出す言葉をここにまとめる
 */
import type {
  CsvFixedColumn,
  CsvFixedLayout,
  CsvSavedLayout,
  CsvWidthUnit,
} from "../../types";

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
  const cut = layout.newline ? "" : "・改行なし";
  const mix = layout.key ? "・種別混在" : "";
  return `固定長 ${n}桁 (計${total}${UNIT_LABEL[layout.unit]}${cut}${mix})`;
}

/** 桁の並びが同じ中身か */
function sameColumns(a: CsvFixedColumn[], b: CsvFixedColumn[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c, i) => {
    const d = b[i];
    return (
      c.width === d.width &&
      c.align === d.align &&
      c.pad === d.pad &&
      c.name === d.name
    );
  });
}

/**
 * 2つの桁設定が同じ中身か。
 *
 * 桁の幅だけでなく、寄せ・埋め文字・項目名まで見る
 * (どれか1つでも違えば、読んだ結果が変わるため)
 */
export function sameLayout(
  a: CsvFixedLayout | null,
  b: CsvFixedLayout | null
): boolean {
  if (!a || !b) return false;
  if (a.unit !== b.unit || a.trim !== b.trim) return false;
  if (a.newline !== b.newline) return false;
  if (!sameColumns(a.header, b.header)) return false;
  if (!sameColumns(a.trailer, b.trailer)) return false;
  if (a.key?.at !== b.key?.at) return false;
  if (a.key?.len !== b.key?.len) return false;
  if (a.key?.header !== b.key?.header) return false;
  return sameColumns(a.columns, b.columns);
}

/**
 * 今の桁設定と同じお気に入りの名前 (無ければ null)。
 *
 * どのお気に入りで読んでいるかを覚えておく代わりに、中身を見比べて求める。
 * こうしておくと、取り消しや読み直しのあとでもずれない
 */
export function appliedLayoutName(
  layouts: CsvSavedLayout[],
  fixed: CsvFixedLayout | null
): string | null {
  if (!fixed) return null;
  return layouts.find((s) => sameLayout(s.layout, fixed))?.name ?? null;
}
