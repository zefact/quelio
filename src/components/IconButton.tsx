import type { ButtonHTMLAttributes, ReactNode } from "react";

interface Props
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title" | "children"> {
  /**
   * 何をするボタンか (例: 「設定」「SQLダンプを書き出す (⌘E)」)。
   * ツールチップと、読み上げ用の名前 (aria-label) の両方に使う
   */
  label: string;
  /** 絵 (SVG など)。文字を添えるならここに一緒に入れる */
  children: ReactNode;
  /** ツールチップを左端そろえで右へ伸ばす (画面の左側のボタン用。左端で切れないように) */
  tipLeft?: boolean;
}

/**
 * 絵だけのボタン。
 *
 * ツールチップは has-tooltip (TooltipLayer が描く) で出す。
 * ツールチップは読み上げに使われないので、同じ文を aria-label にも入れる。
 * マウスを乗せたときだけでなく、キーボードで移ってきたときにも出る
 */
export function IconButton({
  label,
  children,
  className,
  tipLeft,
  type = "button",
  ...rest
}: Props) {
  return (
    <button
      type={type}
      className={
        (className ? className + " " : "") +
        "has-tooltip" +
        (tipLeft ? " tooltip-left" : "")
      }
      data-tooltip={label}
      aria-label={label}
      {...rest}
    >
      {children}
    </button>
  );
}
