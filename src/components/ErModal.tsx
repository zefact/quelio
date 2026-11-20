import { ReactNode, useEffect } from "react";
import { ModalFrame } from "./ModalFrame";

interface Props {
  /**
   * 以前は見出しの丸アイコンに入れていた記号。
   * 枠を共通の ModalFrame に寄せたので、今は使わない (呼び出し側を変えずに済むよう残す)
   */
  icon?: string;
  /** 以前の赤いアイコン用。今は使わない (消す確認は ConfirmDialog を使う) */
  danger?: boolean;
  title: string;
  /** 見出しの下の小さい説明 */
  sub?: ReactNode;
  /** 説明を等幅で出す (接続名やDB名) */
  subMono?: boolean;
  /** 一覧など、中身が広い画面で枠を広げる */
  wide?: boolean;
  /** 本文 */
  children: ReactNode;
  /** 右下の主ボタン (「キャンセル」はこちらで左に置く) */
  actions: ReactNode;
  onClose: () => void;
}

/**
 * ER図ウィンドウのダイアログの枠。
 * 見出し・×・Esc や背景クリックで閉じる作法は、共通の ModalFrame に任せる
 */
export function ErModal({
  title,
  sub,
  subMono,
  wide,
  children,
  actions,
  onClose,
}: Props) {
  /*
   * 開いたら最初の入力欄へフォーカスする。
   * 共通の枠は開いたときに枠そのものへフォーカスするので、
   * 中の入力欄の autoFocus が外れてしまう。そのあとで当て直す
   * (この effect は枠の effect より後に走る)
   */
  useEffect(() => {
    const boxes = document.querySelectorAll<HTMLElement>(".modal.er-modal-frame");
    const box = boxes[boxes.length - 1];
    box?.querySelector<HTMLElement>("input, textarea")?.focus();
  }, []);

  return (
    <ModalFrame
      title={title}
      onClose={onClose}
      className={"er-modal-frame" + (wide ? " er-modal-wide" : "")}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            キャンセル
          </button>
          {actions}
        </>
      }
    >
      {sub !== undefined && (
        <div className={"er-modal-sub" + (subMono ? " mono" : "")}>{sub}</div>
      )}
      {children}
    </ModalFrame>
  );
}
