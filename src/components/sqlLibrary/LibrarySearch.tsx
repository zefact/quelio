/**
 * 履歴・お気に入りの検索欄。
 *
 * メニューを開いたらすぐ打ち込めるよう、自分でフォーカスを取る
 */
import { useEffect, useRef } from "react";
import { imeBusy } from "../../ime";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** 何を探す欄かの案内 (履歴とお気に入りで変える) */
  placeholder: string;
  /** Esc を押したときの後始末 (呼び出し側でメニューを閉じるなど) */
  onEscape?: () => void;
}

export function LibrarySearch({
  value,
  onChange,
  placeholder,
  onEscape,
}: Props) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="lib-search">
      <input
        ref={ref}
        className="lib-search-input"
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // 日本語入力の変換中のEscは拾わない (変換の取り消しのため)
          if (imeBusy(e)) return;
          if (e.key !== "Escape") return;
          // 打ち込んだ語があるときは、まず語を消す (メニューは閉じない)
          if (value) {
            e.stopPropagation();
            onChange("");
            return;
          }
          onEscape?.();
        }}
      />
      {value && (
        <button
          className="lib-search-clear"
          title="探す語を消す"
          aria-label="探す語を消す"
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
