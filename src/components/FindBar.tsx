import { useCallback, useEffect, useRef, useState } from "react";
import { FIND_EVENT } from "../appEvents";
import { editorFinder } from "../editorSearch";

/**
 * ページ内の可視テキストから query の一致範囲を列挙する。
 * window.find() はWKWebViewで入力欄からフォーカスを奪う・一致位置へ
 * スクロールしないなど挙動が不安定なため、自前で走査する。
 * (テキストノード内の一致のみ。ノードをまたぐ一致は対象外)
 */
function collectMatches(query: string): Range[] {
  const q = query.toLowerCase();
  const ranges: Range[] = [];
  if (!q) return ranges;

  /** 要素ごとの可視判定キャッシュ (テキストノード数が多い結果グリッド対策) */
  const visible = new Map<Element, boolean>();
  const isVisible = (el: Element): boolean => {
    const cached = visible.get(el);
    if (cached !== undefined) return cached;
    const fn = (
      el as Element & { checkVisibility?: () => boolean }
    ).checkVisibility;
    const v = fn ? fn.call(el) : true;
    visible.set(el, v);
    return v;
  };

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        // 検索バー自身と script/style は対象外
        if (el.closest(".find-bar")) return NodeFilter.FILTER_REJECT;
        const tag = el.tagName;
        if (tag === "SCRIPT" || tag === "STYLE") {
          return NodeFilter.FILTER_REJECT;
        }
        return isVisible(el)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    }
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    const lower = text.toLowerCase();
    let idx = 0;
    while ((idx = lower.indexOf(q, idx)) !== -1) {
      const r = document.createRange();
      r.setStart(node, idx);
      r.setEnd(node, idx + q.length);
      ranges.push(r);
      idx += q.length;
    }
  }
  return ranges;
}

/** 前回の一致箇所の親要素 (塗り残しの強制再描画に使う) */
let prevParents: HTMLElement[] = [];

/** 全一致範囲を強調表示する (現在位置は濃い色で区別)。
 * Custom Highlight APIがあれば選択を使わずに強調する。テキスト選択を使うと
 * user-select:none な領域 (ER図など) で入力欄のキャレットが奪われて
 * 検索欄に文字が入力できなくなるため */
function applyHighlights(matches: Range[], activeIdx: number): void {
  const cssAny = CSS as unknown as {
    highlights?: Map<string, unknown>;
  };
  const HighlightCtor = (
    window as unknown as { Highlight?: new (...r: Range[]) => unknown }
  ).Highlight;
  if (cssAny.highlights && HighlightCtor) {
    if (matches.length > 0) {
      cssAny.highlights.set("quelio-find", new HighlightCtor(...matches));
      cssAny.highlights.set(
        "quelio-find-active",
        new HighlightCtor(matches[activeIdx] ?? matches[0])
      );
    } else {
      cssAny.highlights.delete("quelio-find");
      cssAny.highlights.delete("quelio-find-active");
    }
    // WebKitはHighlightから外れた範囲を再描画せず塗りが残ることがある
    // (ホバー等で再描画されると消える)。前回の一致箇所の要素に
    // 見た目に影響しないtext-shadowを一瞬付けて強制的に再描画させる
    const stale = prevParents;
    const seen = new Set<HTMLElement>();
    prevParents = [];
    for (const r of matches) {
      const el = r.startContainer.parentElement;
      if (el && !seen.has(el)) {
        seen.add(el);
        prevParents.push(el);
      }
    }
    if (stale.length > 0) {
      for (const el of stale) {
        el.style.textShadow = "0 0 0 transparent";
      }
      requestAnimationFrame(() => {
        for (const el of stale) el.style.textShadow = "";
      });
    }
    return;
  }
  // フォールバック: 現在位置のみ選択で強調
  const sel = window.getSelection();
  sel?.removeAllRanges();
  if (matches.length > 0) sel?.addRange(matches[activeIdx] ?? matches[0]);
}

/** 現在の一致位置を画面内へスクロールする */
function scrollToMatch(range: Range): void {
  const el =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  if (!el) return;
  // ER図キャンバス内はscrollIntoViewだと表示座標が壊れるため、
  // キャンバス側にパンしてもらう (ズームは変えない)
  if (el.closest(".er-canvas")) {
    window.dispatchEvent(
      new CustomEvent("quelio-find-reveal-er", { detail: el })
    );
    return;
  }
  el.scrollIntoView({ block: "center", inline: "nearest" });
}

/**
 * ページ全体を対象にした検索バー (Cmd/Ctrl+F)。
 * Enter / ↓で次へ、Shift+Enter / ↑で前へ、Escで閉じる。
 * 検索中も入力欄からフォーカスを奪わない (選択は非アクティブ表示になる)。
 */
export function FindBar() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** 一致件数と現在位置 (1始まり。0件時は0) */
  const [total, setTotal] = useState(0);
  const [pos, setPos] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  /** SQLエディタから開いたか (エディタ本文の検索へ渡す) */
  const editorMode = useRef(false);
  /** 現在の一致一覧 (queryと対応。DOM変化時はfindFreshで再収集される) */
  const matchesRef = useRef<Range[]>([]);
  const indexRef = useRef(0);
  /** 現在の検索語で一度でも一致位置へ移動したか
   * (入力中は移動せず、最初のEnter/↑↓で現在位置へ移動する) */
  const revealedRef = useRef(false);

  /** 検索欄のフォーカスとキャレット位置を維持する (奪われた場合に戻す) */
  const keepFocus = useCallback(() => {
    const el = inputRef.current;
    if (!el || document.activeElement === el) return;
    const s = el.selectionStart ?? el.value.length;
    const t = el.selectionEnd ?? s;
    el.focus();
    el.setSelectionRange(s, t);
  }, []);

  /** 検索語の変更: 一致を集め直して先頭を表示 */
  const findFresh = useCallback(
    (q: string) => {
      setQuery(q);
      const matches = collectMatches(q);
      matchesRef.current = matches;
      indexRef.current = 0;
      setTotal(matches.length);
      setPos(matches.length > 0 ? 1 : 0);
      // 入力中は強調のみ行い、画面は移動しない (Enter/↑↓で移動する)
      revealedRef.current = false;
      applyHighlights(matches, 0);
      // 環境によって強調表示がフォーカスを奪うことがあるため戻す
      keepFocus();
      requestAnimationFrame(keepFocus);
    },
    [keepFocus]
  );

  /** 次(前)の一致へ移動。ページ送り等でDOMが変わった場合は集め直す */
  const findNext = useCallback(
    (backwards: boolean) => {
      /*
       * SQLエディタから開いたときは、エディタ本文を直接探す。
       * 画面に出ている行だけを見る方式では、
       * 画面外の行 (CodeMirrorが描いていない行) が見つからないため
       */
      if (editorMode.current) {
        const find = editorFinder();
        if (find) {
          const hit = find(query, !backwards);
          setTotal(hit ? 1 : 0);
          setPos(hit ? 1 : 0);
          // エディタ側にフォーカスが移った場合に備えて戻す
          keepFocus();
          requestAnimationFrame(keepFocus);
          return;
        }
      }
      let matches = matchesRef.current;
      // 範囲が壊れている(0幅になった)場合はDOMが変わったとみなして再収集
      if (matches.length === 0 || matches.some((r) => r.collapsed)) {
        matches = collectMatches(query);
        matchesRef.current = matches;
        indexRef.current = 0;
        setTotal(matches.length);
      }
      if (matches.length === 0) {
        setPos(0);
        return;
      }
      const n = matches.length;
      // 最初のEnter/↑↓は現在位置 (1件目) へ移動し、以降は次(前)へ進む
      const next = revealedRef.current
        ? backwards
          ? (indexRef.current - 1 + n) % n
          : (indexRef.current + 1) % n
        : indexRef.current;
      revealedRef.current = true;
      indexRef.current = next;
      setPos(next + 1);
      applyHighlights(matches, next);
      scrollToMatch(matches[next]);
      keepFocus();
      requestAnimationFrame(keepFocus);
    },
    [query, keepFocus]
  );

  const close = useCallback(() => {
    setOpen(false);
    applyHighlights([], 0);
    window.getSelection()?.removeAllRanges();
  }, []);

  // 閉じたとき・アンマウント時は必ず強調を消す
  useEffect(() => {
    if (!open) applyHighlights([], 0);
    return () => applyHighlights([], 0);
  }, [open]);

  /** 検索を開く (ボタンからも呼ぶ) */
  const openFind = useCallback(() => {
    // SQLエディタで開いた場合は、エディタ本文も探せるようにする
    // (画面に出ている行だけを見る方式だと、折りたたまれた行が見つからない)
    editorMode.current = !!(
      document.activeElement as HTMLElement | null
    )?.closest(".cm-editor");
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }, []);

  // ツールバーの検索ボタンからも開けるようにする
  useEffect(() => {
    const onFind = () => openFind();
    window.addEventListener(FIND_EVENT, onFind);
    return () => window.removeEventListener(FIND_EVENT, onFind);
  }, [openFind]);

  // グローバルショートカット (Cmd/Ctrl+F で開く、F3 で次へ、Esc で閉じる)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 変換中のEscは変換の取り消しなので、検索バーは閉じない
      if (e.isComposing) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        openFind();
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
  }, [findNext, close, openFind]);

  if (!open) return null;

  const notFound = query !== "" && total === 0;

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
          // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            findNext(e.shiftKey);
          }
        }}
      />
      <span className="find-count mono">
        {query === "" ? "" : `${pos}/${total}`}
      </span>
      {/* mousedownを抑止して入力欄のフォーカスを保つ */}
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => findNext(true)}
        title="前へ (Shift+Enter)"
      >
        ↑
      </button>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => findNext(false)}
        title="次へ (Enter)"
      >
        ↓
      </button>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={close}
        title="閉じる (Esc)"
      >
        ×
      </button>
    </div>
  );
}
