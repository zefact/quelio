import { useCallback, useEffect, useRef, useState } from "react";

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

/** 一致範囲を選択状態にして画面内へスクロールする */
function revealMatch(range: Range): void {
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  const el =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  el?.scrollIntoView({ block: "center", inline: "nearest" });
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
  /** 現在の一致一覧 (queryと対応。DOM変化時はfindFreshで再収集される) */
  const matchesRef = useRef<Range[]>([]);
  const indexRef = useRef(0);

  /** 検索語の変更: 一致を集め直して先頭を表示 */
  const findFresh = useCallback((q: string) => {
    setQuery(q);
    const matches = collectMatches(q);
    matchesRef.current = matches;
    indexRef.current = 0;
    setTotal(matches.length);
    setPos(matches.length > 0 ? 1 : 0);
    if (matches.length > 0) {
      revealMatch(matches[0]);
    } else {
      window.getSelection()?.removeAllRanges();
    }
  }, []);

  /** 次(前)の一致へ移動。ページ送り等でDOMが変わった場合は集め直す */
  const findNext = useCallback(
    (backwards: boolean) => {
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
      const next = backwards
        ? (indexRef.current - 1 + n) % n
        : (indexRef.current + 1) % n;
      indexRef.current = next;
      setPos(next + 1);
      revealMatch(matches[next]);
    },
    [query]
  );

  const close = useCallback(() => {
    setOpen(false);
    window.getSelection()?.removeAllRanges();
  }, []);

  // グローバルショートカット (Cmd/Ctrl+F で開く、F3 で次へ、Esc で閉じる)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
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
