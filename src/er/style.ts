/** ER図の枠 (グループ) の色。ErWindowから切り出したもの */
import { PRESET_COLORS } from "../colors";

/**
 * 枠線の色プリセット (先頭の空文字は既定の色)。
 * 選べる色は接続・フォルダと同じものにそろえる
 */
export const FRAME_COLORS: readonly string[] = ["", ...PRESET_COLORS];

/** 背景塗りの透明度 */
export const FILL_ALPHA = 0.25;

/** #rrggbb をアルファ付きrgba()にする */
export function hexAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
