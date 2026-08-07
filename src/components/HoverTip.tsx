import { ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  /** ツールチップ本文 (未指定なら普通のspanとして描画) */
  text?: string;
  children: ReactNode;
  className?: string;
}

const TIP_WIDTH = 340;

/**
 * ヘッダ用の説明ツールチップ。
 * ホバー時に位置を計算してbody直下にポータル表示するため、
 * スクロールコンテナにクリップされず、スクロール/リサイズ後も正しい位置に出る。
 */
export function HoverTip({ text, children, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

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
          });
        }}
        onMouseLeave={() => setPos(null)}
      >
        {children}
      </span>
      {pos &&
        createPortal(
          <div className="hover-tip" style={{ left: pos.x, top: pos.y }}>
            {text}
          </div>,
          document.body
        )}
    </>
  );
}
