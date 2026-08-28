/**
 * ショートカットキーの表記。
 *
 * macOSは記号、それ以外は Ctrl+ / Shift+ と書く。
 * 表記を2か所以上で書くとずれるので、ここだけに置く
 */
const MAC = navigator.userAgent.includes("Mac");

export const MOD = MAC ? "⌘" : "Ctrl+";
export const SHIFT = MAC ? "⇧" : "Shift+";
export const CTRL = MAC ? "⌃" : "Ctrl+";
