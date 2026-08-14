import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { ConsoleWindow } from "./components/ConsoleWindow";
import { FindBar } from "./components/FindBar";
import { DiffWindow } from "./components/DiffWindow";
import { ErWindow } from "./components/ErWindow";
import { SchemaWindow } from "./components/SchemaWindow";
import { initTheme } from "./theme";
import { blockBrowserShortcuts } from "./blockShortcuts";

initTheme();
blockBrowserShortcuts();

// macOSではタイトルバーをアプリに統合(Overlay)するため、
// 信号機ボタンぶんの余白をCSSで確保できるようクラスを付ける
if (navigator.userAgent.includes("Mac")) {
  document.documentElement.classList.add("macos");
}

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
const content = params.has("console") ? (
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
