import { ReactNode } from "react";

interface Props {
  /** 見出しの丸アイコンに入れる記号 */
  icon: string;
  /** 取り消せない操作は赤くする */
  danger?: boolean;
  title: string;
  /** 見出しの下の小さい説明 */
  sub?: ReactNode;
  /** 説明を等幅で出す (接続名やDB名) */
  subMono?: boolean;
  /** 本文 */
  children: ReactNode;
  /** 右下のボタン列 (「キャンセル」は呼び出し側が置く) */
  actions: ReactNode;
  onClose: () => void;
}

/**
 * ER図ウィンドウのダイアログの共通の枠。
 * 背景クリックで閉じ、中のクリックは通さない
 */
export function ErModal({
  icon,
  danger,
  title,
  sub,
  subMono,
  children,
  actions,
  onClose,
}: Props) {
  return (
    <div className="er-modal-overlay" onMouseDown={onClose}>
      <div className="er-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="er-modal-head">
          <div className={"er-modal-icon" + (danger ? " danger" : "")}>
            {icon}
          </div>
          <div>
            <div className="er-modal-title">{title}</div>
            {sub !== undefined && (
              <div className={"er-modal-sub" + (subMono ? " mono" : "")}>
                {sub}
              </div>
            )}
          </div>
        </div>
        {children}
        <div className="er-modal-actions">
          <button className="btn-ghost er-modal-cancel" onClick={onClose}>
            キャンセル
          </button>
          {actions}
        </div>
      </div>
    </div>
  );
}
