import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePopupPosition } from "../hooks/usePopupPosition";
import { useDismiss } from "../hooks/useDismiss";

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** 未選択時に表示する文言 */
  placeholder?: string;
  disabled?: boolean;
  /** トリガーに追加するクラス (mono等) */
  className?: string;
  /**
   * ドロップダウンをウィンドウ基準の固定配置で出す。
   * overflowのあるコンテナ (モーダル内のスクロール領域等) で
   * メニューがクリップされる場合に使う
   */
  popFixed?: boolean;
}

/**
 * アプリ共通スタイルのセレクトボックス。
 *
 * ネイティブの<select>はドロップダウン部分がOS描画になり、
 * 特にWindows (WebView2) でアプリのテーマと合わない見た目になるため、
 * コンテキストメニューと同じ描画の独自ポップアップで統一する。
 */
export function SelectMenu({
  value,
  options,
  onChange,
  placeholder = "選択",
  disabled = false,
  className = "",
  popFixed = false,
}: Props) {
  const [open, setOpen] = useState(false);
  /** キーボード操作でハイライト中のindex (-1 = なし) */
  const [hover, setHover] = useState(-1);
  /** popFixed時のドロップダウン座標 (開いたときのトリガー位置から計算) */
  const [popPos, setPopPos] = useState({ x: 0, y: 0, w: 0, flipY: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  /** 通常配置 (popFixedでない) のとき、下に入りきらないので上へ出すか */
  const [openUp, setOpenUp] = useState(false);
  // fixed配置のときは、画面の下や右で切れないよう位置を補正する
  const [fixedRef, fixedStyle] = usePopupPosition<HTMLDivElement>(
    popPos.x,
    popPos.y,
    popPos.flipY
  );

  const toggleOpen = () => {
    if (!open && popFixed) {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) {
        setPopPos({
          x: Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)),
          y: r.bottom + 6,
          w: r.width,
          // 下に入らないときは入力欄の上へ出す
          flipY: r.top - 6,
        });
      }
    }
    setOpen((o) => !o);
  };

  useLayoutEffect(() => {
    if (!open || popFixed) return;
    const wrap = wrapRef.current;
    const pop = popRef.current;
    if (!wrap || !pop) return;
    const r = wrap.getBoundingClientRect();
    const h = pop.offsetHeight;
    // 下に入らず、上には入るときだけ上向きにする
    setOpenUp(r.bottom + 9 + h > window.innerHeight - 8 && r.top - 9 - h > 8);
  }, [open, popFixed, options.length]);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? (value || placeholder);

  // 外側クリックで閉じる
  // (モーダル等がstopPropagationしてもここに届くようキャプチャ段階で監視する)
  useDismiss(open, () => setOpen(false), { capture: true, ref: wrapRef });

  // 開いたとき選択中の項目を表示範囲へスクロール
  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setHover(idx);
    if (idx >= 0) {
      popRef.current
        ?.querySelectorAll(".select-menu-item")
        [idx]?.scrollIntoView({ block: "nearest" });
    }
  }, [open, options, value]);

  const commit = (v: string) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!open) {
        toggleOpen();
      } else if (hover >= 0 && hover < options.length) {
        commit(options[hover].value);
      }
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        toggleOpen();
        return;
      }
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const next = Math.min(Math.max(hover + dir, 0), options.length - 1);
      setHover(next);
      popRef.current
        ?.querySelectorAll(".select-menu-item")
        [next]?.scrollIntoView({ block: "nearest" });
    }
  };

  return (
    <div className="select-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`db-select select-menu-trigger ${className}`}
        disabled={disabled}
        onClick={toggleOpen}
        onKeyDown={onKeyDown}
        title={label}
      >
        <span className={"select-menu-label" + (selected ? "" : " placeholder")}>
          {label}
        </span>
      </button>
      {open && (
        <div
          className={"select-menu-pop" + (!popFixed && openUp ? " up" : "")}
          ref={(el) => {
            popRef.current = el;
            if (popFixed) fixedRef.current = el;
          }}
          role="listbox"
          style={
            popFixed
              ? {
                  position: "fixed",
                  minWidth: popPos.w,
                  zIndex: 300,
                  ...fixedStyle,
                }
              : undefined
          }
        >
          {options.length === 0 && (
            <div className="select-menu-empty">(選択肢がありません)</div>
          )}
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={
                "select-menu-item" +
                (o.value === value ? " checked" : "") +
                (i === hover ? " hover" : "")
              }
              onMouseEnter={() => setHover(i)}
              onClick={() => commit(o.value)}
            >
              <span className="select-menu-check" aria-hidden>
                {o.value === value ? "✓" : ""}
              </span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
