import { useId, type ReactNode } from "react";
import { CloseMark } from "./CloseMark";
import { ModalShell } from "./ModalShell";
import { ProdBadge } from "./ProdBadge";

interface Props {
  /** 見出し */
  title: ReactNode;
  /** 見出しの右に出す対象名 (テーブル名・接続名など) */
  target?: ReactNode;
  /** 本番接続への操作か (見出しに「本番」のバッジを出す) */
  prod?: boolean;
  /** 閉じる (Esc・背景クリック・× から呼ばれる) */
  onClose: () => void;
  /**
   * 閉じてよいか。
   * 実行中・ファイルの準備中など、途中で閉じると困る間は false にする
   * (Esc・背景クリック・× のどれでも閉じなくなる)
   */
  closable?: boolean;
  /**
   * 背景のクリックで閉じるか (既定は閉じる)。
   * 書きかけの内容があるときなど、うっかり消えると困る間は false にする
   * (Esc と × では閉じられる)
   */
  closeOnBackdrop?: boolean;
  /** 枠に足す class (幅などを画面ごとに変えるため) */
  className?: string;
  /** 本文 */
  children: ReactNode;
  /**
   * 下のボタン欄の中身。
   * 並びは [キャンセル/閉じる] [主ボタン] の順で、右に寄せる。
   * 窓が低いときもボタンが隠れないよう、下に貼り付ける
   */
  footer?: ReactNode;
  /** ボタン欄の左に出す短い注意文など */
  footerNote?: ReactNode;
}

/**
 * ダイアログの共通の枠。
 *
 * 見出し (タイトル・対象名・本番バッジ)、閉じるボタン、ボタン欄の置き方、
 * Esc や背景クリックで閉じる作法を、どのダイアログでも同じにする。
 * 新しく作るダイアログはこれを使う
 */
export function ModalFrame({
  title,
  target,
  prod,
  onClose,
  closable = true,
  closeOnBackdrop = true,
  className,
  children,
  footer,
  footerNote,
}: Props) {
  const titleId = useId();
  return (
    <ModalShell
      labelledBy={titleId}
      onClose={onClose}
      closable={closable}
      closeOnBackdrop={closeOnBackdrop}
      className={className}
    >
      <div className="modal-head">
        <span className="modal-title" id={titleId}>
          {title}
          {target && <span className="modal-target mono">{target}</span>}
          {prod && <ProdBadge />}
        </span>
        <button
          className="modal-close has-tooltip"
          onClick={onClose}
          disabled={!closable}
          data-tooltip="閉じる (Esc)"
          aria-label="閉じる"
        >
          <CloseMark size={13} />
        </button>
      </div>
      {children}
      {(footer || footerNote) && (
        <div className="modal-actions">
          {footerNote && (
            <span className="modal-actions-note">{footerNote}</span>
          )}
          <span className="toolbar-spacer" />
          {footer}
        </div>
      )}
    </ModalShell>
  );
}
