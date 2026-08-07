/**
 * カラーモード (ライト/ダーク/システム連動)。
 * 選択は localStorage に保存し、全ウィンドウで storage イベントを通じて同期する。
 */

export type ColorMode = "light" | "dark" | "system";

const STORAGE_KEY = "quelio-color-mode";
const media = window.matchMedia("(prefers-color-scheme: light)");

export function getColorMode(): ColorMode {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function resolve(mode: ColorMode): "light" | "dark" {
  if (mode === "system") return media.matches ? "light" : "dark";
  return mode;
}

function apply() {
  document.documentElement.dataset.theme = resolve(getColorMode());
}

/** カラーモードを変更して即時反映する */
export function setColorMode(mode: ColorMode) {
  localStorage.setItem(STORAGE_KEY, mode);
  apply();
}

/** 起動時に呼ぶ。OS設定の変化・他ウィンドウでの変更にも追従する */
export function initTheme() {
  apply();
  media.addEventListener("change", apply);
  // 他ウィンドウ(コンソール/差分/一覧)での変更を反映
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) apply();
  });
}
