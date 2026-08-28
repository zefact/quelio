/** ER図の枠 (グループ) の色。ErWindowから切り出したもの */

/** 枠線の色プリセット (先頭の空文字は既定のグレー) */
export const FRAME_COLORS = [
  "",
  "#6366f1",
  "#22d3ee",
  "#34d399",
  "#fbbf24",
  "#f87171",
  "#f472b6",
] as const;

/** 背景塗りの透明度 */
export const FILL_ALPHA = 0.25;

/** #rrggbb をアルファ付きrgba()にする */
export function hexAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
