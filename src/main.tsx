import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { ConsoleWindow } from "./components/ConsoleWindow";
import { CsvWindow } from "./components/csv/CsvWindow";
import { FindBar } from "./components/FindBar";
import { DiffWindow } from "./components/DiffWindow";
import { ErWindow } from "./components/ErWindow";
import { SchemaWindow } from "./components/SchemaWindow";
import { initTheme } from "./theme";
import {
  blockBrowserShortcuts,
  blockSave,
  blockSelectAll,
} from "./blockShortcuts";

initTheme();
blockBrowserShortcuts();
blockSelectAll();

// macOSではタイトルバーをアプリに統合(Overlay)するため、
// 信号機ボタンぶんの余白をCSSで確保できるようクラスを付ける
if (navigator.userAgent.includes("Mac")) {
  document.documentElement.classList.add("macos");
}

/*
 * 別のウィンドウが前に出ているあいだは、ヒントを出さない。
 *
 * ボタンを押して新しいウィンドウが開くと、こちらの窓には
 * マウスが離れた知らせが来ないため、CSSの :hover が残り続け、
 * ヒントが出しっぱなしになる。窓が前後したら印を付け外しして消す
 */
const markBlur = (blurred: boolean) =>
  document.documentElement.classList.toggle("win-blur", blurred);
window.addEventListener("blur", () => markBlur(true));
window.addEventListener("focus", () => markBlur(false));

// 右クリックでWebView標準メニュー(Reload等)を出さない。
// 入力欄はコピー/ペースト等の編集メニューが必要なので除外する
// (SQLエディタは独自メニュー側でpreventDefault済み)
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, [contenteditable='true']")) return;
  e.preventDefault();
});

// URLパラメータでウィンドウの役割を切り替える
const params = new URLSearchParams(window.location.search);
// ⌘Sを使う画面 (メインウィンドウ) 以外では、
// ブラウザの保存ダイアログが出ないようにここで止める。
// メインウィンドウはApp側が既定の動作を止めたうえで使う
// CSVエディタは⌘Sで保存するので、ここには入れない (画面側で受ける)
if (
  params.has("console") ||
  params.has("diff") ||
  params.has("schema") ||
  params.has("er")
) {
  blockSave();
}

const content = params.has("csv") ? (
  <CsvWindow />
) : params.has("console") ? (
  <ConsoleWindow />
) : params.has("diff") ? (
  <DiffWindow />
) : params.has("schema") ? (
  <SchemaWindow />
) : params.has("er") ? (
  <ErWindow />
) : (
  <App />
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* ページ内検索 (Cmd/Ctrl+F)。どのウィンドウでも使えるようルートに置く */}
    <FindBar />
    {content}
  </React.StrictMode>,
);
