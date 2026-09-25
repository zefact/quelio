/**
 * ER図のExcel出力でバックエンドへ渡す形。
 *
 * Rust側 (src-tauri/src/er_xlsx/model.rs) と同じ並び。
 * 座標はすべて画面のピクセル、色は "RRGGBB"
 */

/** 半透明を含む色 */
export interface XlsxPaint {
  rgb: string;
  /** 0 (透明) 〜 1 (不透明) */
  alpha: number;
}

export type XlsxDash = "solid" | "dash" | "dot";

export interface XlsxCell {
  text: string;
  color: string;
  /** 等幅フォントで書くか */
  mono: boolean;
}

export interface XlsxTable {
  name: string;
  logical: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 列 (名前 / 型 / 日本語名) を揃える区切りの位置 */
  tabs: number[];
  rows: XlsxCell[][];
}

/** 線の端がつながる場所 */
export interface XlsxGlue {
  table: number;
  target: { kind: "row"; index: number } | { kind: "head" } | { kind: "body" };
  side: "top" | "left" | "bottom" | "right";
}

export interface XlsxEdge {
  name: string;
  points: [number, number][];
  color: XlsxPaint;
  dash: XlsxDash;
  from: XlsxGlue | null;
  to: XlsxGlue | null;
}

export interface XlsxFrame {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rounded: boolean;
  stroke: XlsxPaint | null;
  dash: XlsxDash;
  fill: XlsxPaint | null;
  labelColor: string;
  front: boolean;
}

export interface XlsxLabel {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  color: string;
  bold: boolean;
  mono: boolean;
}

export interface XlsxErSheet {
  name: string;
  palette: {
    text: string;
    dim: string;
    nodeFill: XlsxPaint;
    nodeStroke: XlsxPaint;
    headFill: XlsxPaint;
  };
  headH: number;
  rowH: number;
  padX: number;
  tables: XlsxTable[];
  frames: XlsxFrame[];
  edges: XlsxEdge[];
  labels: XlsxLabel[];
}

/** "#rrggbb" / "rgba(r, g, b, a)" を色に直す (読めなければ黒) */
export function toPaint(css: string, alpha = 1): XlsxPaint {
  const hex = /^#?([0-9a-f]{6})$/i.exec(css.trim());
  if (hex) return { rgb: hex[1].toUpperCase(), alpha };
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
    css.trim()
  );
  if (m) {
    const h = (v: string) =>
      Math.min(255, Number(v)).toString(16).padStart(2, "0").toUpperCase();
    const a = m[4] === undefined ? 1 : Number(m[4]);
    return { rgb: h(m[1]) + h(m[2]) + h(m[3]), alpha: a * alpha };
  }
  return { rgb: "000000", alpha };
}

/** 文字色 (不透明の "RRGGBB") */
export function toRgb(css: string): string {
  return toPaint(css).rgb;
}
