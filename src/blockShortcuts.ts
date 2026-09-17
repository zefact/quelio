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
        // 印刷 / ファイルを開く / ダウンロード一覧 / ソース表示
        // ※ Ctrl(Cmd)+S はアプリ側で「SQLをお気に入りへ保存」に使うので抑止しない
        (ctrl && (key === "p" || key === "o" || key === "j" || key === "u"));

      if (isBlocked) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    // アプリ内のリスナーより先に処理するためcaptureで登録する
    { capture: true }
  );
}

/**
 * ブラウザの「名前を付けて保存」(Ctrl/Cmd+S) を止める。
 *
 * WindowsのWebView2では保存ダイアログが出てしまう。
 * アプリ側では「SQLをお気に入りへ保存」に使っているが、
 * その処理を持たないウィンドウ (コンソール・ER図・スキーマ・差分) でも
 * ダイアログが出ないよう、ここで既定の動作だけを止める。
 * 伝播は止めないのでアプリ側のショートカットはそのまま動く
 */
export function blockSave(): void {
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "s") return;
      e.preventDefault();
    },
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

/**
 * 置き場所ではないところに落とされたファイルを、黙って受け流す。
 *
 * メインウィンドウはOSの落とし込みをTauriに任せず、WebViewで受けている
 * (CSV取り込みがファイルの中身を読むため。`dragDropEnabled: false`)。
 * そのため、置き場所の外に落とすとWebViewの既定の動きが働き、
 * **落としたファイルをそのまま開いて** 画面がその中身で覆われてしまう。
 *
 * 見分けるのは「ファイルの落とし込みで、まだどこも受け取っていないもの」だけ。
 * - 文字の落とし込み (SQLエディタ・入力欄) は邪魔しない
 * - 置き場所 (CSV取り込み・データ転送) は自分で preventDefault するので、
 *   ここへ来る時点で受け取り済みになっている
 *
 * ほかの抑止と違って capture では登録しない。
 * 先に走ると、置き場所より前に落とし込みを取り上げてしまう
 */
/** ファイルを受け取る場所の印 (CSV取り込み・データ転送の置き場所) */
const FILE_DROP_TARGET = "[data-file-drop]";

export function blockStrayFileDrop(): void {
  const swallow = (e: DragEvent) => {
    const types = e.dataTransfer ? Array.from(e.dataTransfer.types) : undefined;
    const el = e.target instanceof Element ? e.target : null;
    const inside = !!el?.closest(FILE_DROP_TARGET);
    if (!isStrayFileDrop(e.defaultPrevented, types, inside)) return;
    /*
     * 「ここには置けない」とカーソルに出す。
     *
     * dragenter でも伝える。WebKitは落とし込みを受けるかどうかを
     * 入った時点でも見ているため、dragover だけでは
     * 「置ける」カーソル (macOSの緑の＋) が残ることがある
     */
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    /*
     * 既定の動きを止める。
     * 止めないとWebViewが落とし込みを受け取り、
     * ファイルを開いて画面がその中身で覆われてしまう
     */
    e.preventDefault();
  };
  // 入った時点・移動中・落とした時点の3つで同じ判断をする
  for (const name of ["dragenter", "dragover", "drop"] as const) {
    window.addEventListener(name, swallow);
  }
}

/**
 * ファイルの落とし込みで、どこも受け取らないものか。
 *
 * `types` に "Files" が入っているかどうかで見分ける
 * (中身を読まずに種類だけ見られる)
 */
export function isStrayFileDrop(
  defaultPrevented: boolean,
  types: readonly string[] | undefined,
  /** 受け取る場所の中か (`[data-file-drop]` の内側) */
  insideDropTarget: boolean
): boolean {
  // 受け取る場所は自分で扱う。ここで横取りしない
  if (defaultPrevented || insideDropTarget) return false;
  return !!types?.includes("Files");
}
