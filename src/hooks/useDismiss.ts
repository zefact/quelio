import { useEffect, useRef } from "react";

/** 閉じるきっかけの調整 */
export type DismissOptions = {
  /**
   * キャプチャ段階で監視する。
   * メニュー内などがmousedownをstopPropagationしていても届くので、
   * 「別のメニューを開いたら閉じる」を成立させたいときに使う
   */
  capture?: boolean;
  /** この要素の内側をクリックしたときは閉じない */
  ref?: { readonly current: HTMLElement | null };
  /** このCSSセレクタに一致する要素の内側をクリックしたときは閉じない */
  inside?: string;
  /** ウィンドウのリサイズでも閉じる (位置がずれた吹き出しを残さない) */
  resize?: boolean;
  /**
   * Escapeでも閉じる。
   * 押されたら preventDefault するので、
   * 同じEscapeで編集の取り消しなど別の処理までは走らない
   */
  escape?: boolean;
  /** trueの間は閉じない (確認ダイアログ表示中など) */
  skip?: boolean;
};

/**
 * Tauriが「窓をつかむ場所」として押さえている要素か。
 *
 * この印の付いた要素を押すと、Tauriがdocumentのバブル段階で
 * mousedown を止めてしまう (stopImmediatePropagation) ため、
 * ふつうの外側クリックの監視には届かない。
 * タブバーの空いている所などがこれに当たり、
 * メニューを開いたまま押しても閉じなかった
 */
function isDragRegion(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.hasAttribute("data-tauri-drag-region")
  );
}

/**
 * メニューや吹き出しを「外側クリック等で閉じる」ための共通フック。
 *
 * @param active 開いている間だけ true にする
 * @param onDismiss 閉じる処理。毎描画で作り直して構わない
 */
export function useDismiss(
  active: boolean,
  onDismiss: () => void,
  opts: DismissOptions = {}
) {
  const {
    capture = false,
    ref,
    inside,
    resize = false,
    escape = false,
    skip = false,
  } = opts;

  // 依存に入れず最新を呼べるようにする (開閉のたびに登録し直さない)
  const cb = useRef(onDismiss);
  cb.current = onDismiss;

  useEffect(() => {
    if (!active || skip) return;

    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (ref?.current && t && ref.current.contains(t)) return;
      if (inside && t?.closest?.(inside)) return;
      cb.current();
    };
    const onOther = () => cb.current();
    const onKey = (e: KeyboardEvent) => {
      // 変換中のEscapeや、他で処理済みのEscapeは拾わない
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      e.preventDefault();
      cb.current();
    };

    /*
     * 窓をつかむ場所のぶんだけ、キャプチャ段階で先回りして拾う。
     * ここを丸ごとキャプチャにしないのは、
     * 内側で mousedown を止めて「閉じない」を作っている画面があるため
     * (capture: true を指定している場合は、そちらで既に拾えている)
     */
    const onDragRegion = (e: MouseEvent) => {
      if (isDragRegion(e.target)) onDown(e);
    };

    document.addEventListener("mousedown", onDown, capture);
    if (!capture) document.addEventListener("mousedown", onDragRegion, true);
    if (resize) window.addEventListener("resize", onOther);
    if (escape) document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, capture);
      if (!capture) {
        document.removeEventListener("mousedown", onDragRegion, true);
      }
      if (resize) window.removeEventListener("resize", onOther);
      if (escape) document.removeEventListener("keydown", onKey);
    };
  }, [active, skip, capture, ref, inside, resize, escape]);
}
