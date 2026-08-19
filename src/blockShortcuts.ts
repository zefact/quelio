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
        // ※ Ctrl(Cmd)+F と F3 はアプリ独自の検索バー (FindBar) が
        //   preventDefault込みで処理するため、ここでは抑止しない
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

/** 文字を選択・編集できる場所か (入力欄・SQLエディタなど) */
function isTextArea(el: HTMLElement | null): boolean {
  return !!el?.closest(
    "input, textarea, select, [contenteditable='true'], .cm-editor"
  );
}

/**
 * 入力欄の外での Cmd/Ctrl+A (ページ全体の選択) を無効にする。
 *
 * WebViewだと画面全体が青く反転してデスクトップアプリらしくないため止める。
 * ただし preventDefault だけに留めて伝播は止めないので、
 * グリッドの「⌘Aで全行選択」などアプリ独自の処理はそのまま動く。
 *
 * リロード抑止と違い、開発中も同じ挙動で確認したいのでDEVでも有効にする
 */
export function blockSelectAll(): void {
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "a") return;
      if (isTextArea(e.target as HTMLElement | null)) return;
      e.preventDefault();
    },
    { capture: true }
  );
}
