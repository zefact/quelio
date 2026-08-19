/** macOSで動いているか (キー表記の切り替えに使う) */
export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** 修飾キーの表記 (macは記号、それ以外は英字) */
export const KEY_ALT = isMac ? "⌥" : "Alt";
export const KEY_CTRL = isMac ? "⌃" : "Ctrl";
export const KEY_MOD = isMac ? "⌘" : "Ctrl";
