import type { ReactNode } from "react";
import { useModal } from "../hooks/useModal";

interface Props {
  /** 読み上げ用の名前 (見出しが無い画面でも、何のダイアログかが分かるように) */
  label?: string;
  /** 見出しの要素の id (見出しがあるときは、名前の代わりにそれを読ませる) */
  labelledBy?: string;
  /** 閉じる (Esc・背景クリックから呼ばれる) */
  onClose: () => void;
  /** 閉じてよいか (false の間は Esc でも背景クリックでも閉じない) */
  closable?: boolean;
  /** 背景のクリックで閉じるか (既定は閉じる) */
  closeOnBackdrop?: boolean;
  /** 枠の class (modal に足す) */
  className?: string;
  children: ReactNode;
}

/**
 * ダイアログの外側だけの共通部品 (背景・枠・Esc・初期フォーカス・読み上げ用の名前)。
 *
 * ふつうのダイアログは見出しとボタン欄の付いた `ModalFrame` を使う。
 * これを直接使うのは、作りが大きく違う画面 (⌘K の検索、設定、「Quelioについて」) だけ。
 * 閉じ方の作法は ModalFrame と同じになる
 */
export function ModalShell({
  label,
  labelledBy,
  onClose,
  closable = true,
  closeOnBackdrop = true,
  className,
  children,
}: Props) {
  const boxRef = useModal(onClose, closable);
  return (
    <div
      className="modal-overlay"
      onMouseDown={closable && closeOnBackdrop ? onClose : undefined}
    >
      <div
        className={"modal" + (className ? " " + className : "")}
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
      >
        {children}
      </div>
    </div>
  );
}
