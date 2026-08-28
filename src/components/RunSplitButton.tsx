import { ReactNode, useRef, useState } from "react";
import { useDismiss } from "../hooks/useDismiss";

/** ▾ で選べる項目 */
export interface RunSplitOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  /** 主ボタンの中身 (実行中はスピナーを入れる) */
  children: ReactNode;
  /** 主ボタンに付けるclass (run-main はこちらで足す) */
  mainClass: string;
  /** ▾ボタンに付けるclass (run-caret はこちらで足す)。省略時は主ボタンと同じ */
  caretClass?: string;
  /** 外枠に足すclass */
  wrapClass?: string;
  /** 主ボタンの説明 (title属性) */
  title?: string;
  /** 主ボタンの説明 (自前ツールチップ。titleの代わり) */
  tooltip?: string;
  disabled?: boolean;
  onClick: () => void;
  /** 選べる項目。空なら▾を出さず単独のボタンにする */
  options?: readonly RunSplitOption<T>[];
  /** 今選んでいる項目 */
  value?: T;
  onSelect?: (value: T) => void;
  caretTitle?: string;
  /** ▾ を押せなくする (実行中など) */
  caretDisabled?: boolean;
}

/** メニューを上向きに出すかを決めるときの、メニューのおおよその高さ */
const MENU_H = 120;

/**
 * 「主ボタン + ▾ + 選択メニュー」のボタン。
 * 実行ボタンとEXPLAINボタンで同じ作りなのでまとめている。
 *
 * メニューは下に入らなければ上向きに出す
 */
export function RunSplitButton<T extends string>({
  children,
  mainClass,
  caretClass,
  wrapClass,
  title,
  tooltip,
  disabled,
  onClick,
  options,
  value,
  onSelect,
  caretTitle,
  caretDisabled,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  /** 下に入りきらないので上向きに出すか */
  const [up, setUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);

  // 他のメニューを開いたときにも閉じるよう、キャプチャ段階で監視する
  useDismiss(open, () => setOpen(false), { capture: true, ref: wrapRef });

  const hasMenu = !!options && options.length > 0;

  return (
    <div className={"run-split" + (wrapClass ? ` ${wrapClass}` : "")} ref={wrapRef}>
      <button
        className={mainClass + (hasMenu ? " run-main" : "")}
        onClick={onClick}
        disabled={disabled}
        title={title}
        data-tooltip={tooltip}
      >
        {children}
      </button>
      {hasMenu && (
        <button
          className={(caretClass ?? mainClass) + " run-caret"}
          ref={caretRef}
          onClick={() => {
            const el = caretRef.current;
            setUp(
              !!el &&
                window.innerHeight - el.getBoundingClientRect().bottom < MENU_H
            );
            setOpen((o) => !o);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          disabled={caretDisabled}
          title={caretTitle}
        >
          ▾
        </button>
      )}
      {hasMenu && open && (
        <div
          className={"context-menu run-menu" + (up ? " up" : "")}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {options!.map((o) => (
            <button
              key={o.value}
              className={"context-item" + (value === o.value ? " checked" : "")}
              onClick={() => {
                setOpen(false);
                onSelect?.(o.value);
              }}
            >
              {value === o.value ? "✓ " : ""}
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
