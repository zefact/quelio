/** アイコン色のプリセットとスタイル生成ヘルパー */
import type { CSSProperties } from "react";

export const PRESET_COLORS: string[] = [
  "#f87171", // 赤
  "#fb923c", // オレンジ
  "#fbbf24", // 黄
  "#34d399", // 緑
  "#22d3ee", // シアン
  "#60a5fa", // 青
  "#a78bfa", // 紫
  "#f472b6", // ピンク
];

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => parseInt(v, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** バッジ(db-badge / folder-icon)用のカスタム色スタイル */
export function badgeStyle(
  color: string | undefined
): CSSProperties | undefined {
  if (!color) return undefined;
  return {
    color,
    background: hexToRgba(color, 0.14),
    borderColor: hexToRgba(color, 0.35),
  };
}

/** タブの色ドット用スタイル */
export function dotStyle(
  color: string | undefined
): CSSProperties | undefined {
  if (!color) return undefined;
  return {
    background: color,
    boxShadow: `0 0 6px ${hexToRgba(color, 0.6)}`,
  };
}
