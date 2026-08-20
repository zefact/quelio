import { ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePopupPosition } from "../hooks/usePopupPosition";

interface Props {
  /** ツールチップ本文 (未指定なら普通のspanとして描画) */
  text?: string;
  children: ReactNode;
  className?: string;
  /** trueの間はツールチップを出さない (メニューを開いているときなど) */
  disabled?: boolean;
}

const TIP_WIDTH = 340;

/**
 * ヘッダ用の説明ツールチップ。
 * ホバー時に位置を計算してbody直下にポータル表示するため、
 * スクロールコンテナにクリップされず、スクロール/リサイズ後も正しい位置に出る。
 */
export function HoverTip({ text, children, className, disabled }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; flipY: number } | null>(
    null
  );
  // 画面の下や右で切れないよう位置を補正する
  const [tipRef, tipStyle] = usePopupPosition<HTMLDivElement>(
    pos?.x ?? 0,
    pos?.y ?? 0,
    pos?.flipY
  );

  if (!text) {
    return <span className={className}>{children}</span>;
  }

  return (
    <>
      <span
        ref={ref}
        className={className ? className + " tip-target" : "tip-target"}
        onMouseEnter={() => {
          const r = ref.current?.getBoundingClientRect();
          if (!r) return;
          setPos({
            // 画面右端で切れないよう左へ寄せる
            x: Math.max(8, Math.min(r.left, window.innerWidth - TIP_WIDTH)),
            y: r.bottom + 8,
            // 下に入らないときは対象の上へ出す
            flipY: r.top - 8,
          });
        }}
        onMouseLeave={() => setPos(null)}
      >
        {children}
      </span>
      {pos &&
        !disabled &&
        createPortal(
          <div className="hover-tip" ref={tipRef} style={tipStyle}>
            {text}
          </div>,
          document.body
        )}
    </>
  );
}
