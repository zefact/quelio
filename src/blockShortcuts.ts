/**
 * WebViewのブラウザ標準ショートカットを無効化する。
 *
 * macOSのWKWebViewでは再読み込み等のショートカットは元々ほぼ効かないが、
 * WindowsのWebView2ではブラウザ由来のアクセラレータキーが有効なため、
 * F5やCtrl+Rで画面がリロードされてアプリの状態(接続・タブ等)が失われてしまう。
 * デスクトップアプリとして不要なブラウザ操作をここでまとめて抑止する。
 *
 * 開発時 (npm run tauri dev) はリロードがデバッグに便利なので抑止しない。
 */
export function blockBrowserShortcuts(): void {
  if (import.meta.env.DEV) return;

  window.addEventListener(
    "keydown",
    (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      const isBlocked =
        // 再読み込み: F5 / Ctrl(Cmd)+R (Shift併用のスーパーリロード含む)
        e.key === "F5" ||
        (ctrl && key === "r") ||
        // ページ内検索: Ctrl(Cmd)+F / F3 (WebView2の検索バー)
        (ctrl && key === "f") ||
        e.key === "F3" ||
        // キャレットブラウズ切替 (WebView2): F7
        e.key === "F7" ||
        // 印刷 / ページ保存 / ファイルを開く / ダウンロード一覧 / ソース表示
        (ctrl && (key === "p" || key === "s" || key === "o" || key === "j" || key === "u"));

      if (isBlocked) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    // アプリ内のリスナーより先に処理するためcaptureで登録する
    { capture: true }
  );
}
