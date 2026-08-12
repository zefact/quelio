import { useEffect, useRef, useState } from "react";

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
}: Props) {
  const [open, setOpen] = useState(false);
  /** キーボード操作でハイライト中のindex (-1 = なし) */
  const [hover, setHover] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? (value || placeholder);

  // 外側クリックで閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

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
        setOpen(true);
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
        setOpen(true);
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
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        title={label}
      >
        <span className={"select-menu-label" + (selected ? "" : " placeholder")}>
          {label}
        </span>
      </button>
      {open && (
        <div className="select-menu-pop" ref={popRef} role="listbox">
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
