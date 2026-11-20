/**
 * ショートカットキーの表記。
 *
 * macOSは記号、それ以外は Ctrl+ / Shift+ と書く。
 * 表記を2か所以上で書くとずれるので、ここだけに置く。
 * 画面に「⌘」を直接書かず、必ずここの MOD などを使う
 * (Windowsでは ⌘ キーが無いので、そのまま出すと読めない)
 */
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

export const MOD = IS_MAC ? "⌘" : "Ctrl+";
export const SHIFT = IS_MAC ? "⇧" : "Shift+";
export const CTRL = IS_MAC ? "⌃" : "Ctrl+";
export const ALT = IS_MAC ? "⌥" : "Alt+";
