import { useCallback, useEffect, useRef, useState } from "react";

/** window.find は WebKit / Blink 拡張のため型定義に存在しない */
type FindFn = (
  text: string,
  caseSensitive: boolean,
  backwards: boolean,
  wrap: boolean
) => boolean;

const nativeFind = (
  text: string,
  backwards: boolean
): boolean => {
  const fn = (window as unknown as { find?: FindFn }).find;
  if (!fn || !text) return false;
  return fn.call(window, text, false, backwards, true);
};

/**
 * ページ全体を対象にした検索バー (Cmd/Ctrl+F)。
 *
 * WebViewの検索機能はmacOS(WKWebView)に存在せず、Windows(WebView2)は
 * blockShortcutsで抑止しているため、アプリ独自の検索バーとして提供する。
 * 検索本体はWebKit/Blink共通の window.find() を使い、一致箇所を
 * 選択状態にしてスクロールする。Enterで次へ、Shift+Enterで前へ、Escで閉じる。
 */
export function FindBar() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [notFound, setNotFound] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const queryRef = useRef(query);
  queryRef.current = query;

  /** 現在位置から次(前)の一致へ移動 */
  const findNext = useCallback((backwards: boolean) => {
    const q = queryRef.current;
    if (!q) return;
    const hit = nativeFind(q, backwards);
    setNotFound(!hit);
    // 検索で入力欄のフォーカスが外れるため戻す
    inputRef.current?.focus();
  }, []);

  /** 入力のたびに先頭から検索し直す (インクリメンタル検索) */
  const findFresh = useCallback((q: string) => {
    setQuery(q);
    window.getSelection()?.removeAllRanges();
    setNotFound(q !== "" && !nativeFind(q, false));
    inputRef.current?.focus();
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setNotFound(false);
  }, []);

  // グローバルショートカット (Cmd/Ctrl+F で開く、F3 で次へ、Esc で閉じる)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        // 選択中のテキストがあれば検索語の初期値にする
        const sel = window.getSelection()?.toString().trim();
        if (sel) setQuery(sel);
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.select());
      } else if (e.key === "F3") {
        e.preventDefault();
        e.stopPropagation();
        if (openRef.current) findNext(e.shiftKey);
      } else if (e.key === "Escape" && openRef.current) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [findNext, close]);

  if (!open) return null;

  return (
    <div className={`find-bar${notFound ? " not-found" : ""}`}>
      <input
        ref={inputRef}
        value={query}
        placeholder="ページ内検索"
        spellCheck={false}
        autoFocus
        onChange={(e) => findFresh(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            findNext(e.shiftKey);
          }
        }}
      />
      <button onClick={() => findNext(true)} title="前へ (Shift+Enter)">
        ↑
      </button>
      <button onClick={() => findNext(false)} title="次へ (Enter)">
        ↓
      </button>
      <button onClick={close} title="閉じる (Esc)">
        ×
      </button>
    </div>
  );
}
