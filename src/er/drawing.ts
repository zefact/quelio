/**
 * ER図を「画面の外」へ描き出すときの共通部分。
 *
 * PNG (canvas) と SVG で同じ配置・同じ色にするため、
 * 入力の形と余白・配色だけをここに置く。
 * 描画そのものは exportPng.ts / exportSvg.ts が持つ
 */
import type { ErEdge, ErNode } from "./model";
import type { ErEdgeStyle, ErFrame } from "../types";

/** 他の線との交差判定に使う縦区間 (geometry.ts の verticalSegments が返す形) */
export type VerticalSegment = { x: number; y1: number; y2: number };

/** 書き出しに要るもの (すべて画面が持っている今の状態) */
export interface ErDrawInput {
  /** 図の見出しに出すデータベース名 */
  database: string;
  nodes: ErNode[];
  /** 図全体の大きさ */
  bounds: { w: number; h: number };
  frames: ErFrame[];
  edges: ErEdge[];
  /** 各エッジの折れ線 (画面に出ているものと同じ経路) */
  edgeGeoms: ([number, number][] | null)[];
  /** エッジごとの線種・色 */
  edgeStyles: Record<string, ErEdgeStyle>;
  /** テーブルの位置 */
  posOf: (name: string) => { x: number; y: number };
  /** i番目のエッジを描くときに飛び越える、他の線の縦区間 */
  verticalsExcept: (i: number) => VerticalSegment[];
  /** ライトテーマで出力するか */
  light: boolean;
}

/** 図の左と上下に取る余白 */
export const PAD = 40;
/** 上部の凡例の高さ */
export const LEGEND_H = 30;
/** 図の左端の位置 (凡例と揃える) */
export const OX = 20;

/** 凡例の文言 */
export const LEGEND_NOTE =
  "破線 = リレーション ・ ● = NOT NULL / ○ = NULL可 (色付き● = 主キー)";

/** 使うフォント (canvas の font 指定と同じ並び) */
export const FONT_MONO = '"SF Mono", Menlo, Consolas, monospace';
export const FONT_UI = '-apple-system, "Hiragino Sans", sans-serif';

export interface ErPalette {
  bg: string;
  title: string;
  text: string;
  dim: string;
  faint: string;
  nodeFill: string;
  nodeStroke: string;
  headFill: string;
  pk: string;
  edge: string;
  frame: string;
}

/** 書き出しの配色。呼び出し側で見ていたテーマに合わせる */
export function erPalette(light: boolean): ErPalette {
  return light
    ? {
        bg: "#f2f3f7",
        title: "#4f46e5",
        text: "#1f2430",
        dim: "#5b6478",
        faint: "#9aa1b5",
        nodeFill: "#ffffff",
        nodeStroke: "rgba(17, 24, 39, 0.2)",
        headFill: "rgba(99, 102, 241, 0.12)",
        pk: "#4f46e5",
        edge: "rgba(99, 102, 241, 0.85)",
        frame: "rgba(91, 100, 120, 0.55)",
      }
    : {
        bg: "#0c0e14",
        title: "#a5b4fc",
        text: "#e7eaf2",
        dim: "#8b93a8",
        faint: "#5b6275",
        nodeFill: "#141824",
        nodeStroke: "rgba(255, 255, 255, 0.18)",
        headFill: "rgba(99, 102, 241, 0.18)",
        pk: "#a5b4fc",
        edge: "rgba(99, 102, 241, 0.8)",
        frame: "rgba(139, 147, 168, 0.55)",
      };
}

/** エッジの線種を破線パターンにする (空文字なら実線) */
export function dashOf(style: ErEdgeStyle["style"] | undefined): string {
  if (style === "solid") return "";
  if (style === "dotted") return "2 4";
  return "5 4";
}

/** 枠の線種を破線パターンにする */
export function frameDashOf(style: ErFrame["style"]): string {
  if (style === "dashed") return "8 5";
  if (style === "dotted") return "2 4";
  return "";
}
