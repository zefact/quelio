import { ErModal } from "./ErModal";
import { ConfirmDialog } from "./ConfirmDialog";
import { imeBusy } from "../ime";

/** 確認 (何をするかは呼び出し側が決める。既定は削除の確認) */
export interface ErConfirm {
  title: string;
  message: string;
  /** 本文の下に添える1行 (既定は「この操作は元に戻せません」) */
  sub?: string;
  /** 実行ボタンの文言 (既定は「削除する」) */
  confirmLabel?: string;
  /** 消す・壊す以外 (上書きの確認など) は primary にする */
  tone?: "danger" | "primary";
  action: () => void;
}

/** 図の名前入力 */
export interface ErNameDialog {
  mode: "saveAs" | "rename";
  value: string;
}

interface Props {
  confirm: ErConfirm | null;
  onCloseConfirm: () => void;

  nameDialog: ErNameDialog | null;
  onChangeName: (value: string) => void;
  onCloseName: () => void;
  onCommitName: () => void;
}

/** ER図ウィンドウのダイアログ2種 (確認 / 名前入力) */
export function ErDialogs({
  confirm,
  onCloseConfirm,
  nameDialog,
  onChangeName,
  onCloseName,
  onCommitName,
}: Props) {
  return (
    <>
      {confirm && (
        // 消す確認では、フォーカスは「キャンセル」に置く (Delete → Enter ですぐ消えないように)
        <ConfirmDialog
          title={confirm.title}
          confirmLabel={confirm.confirmLabel ?? "削除する"}
          tone={confirm.tone ?? "danger"}
          onCancel={onCloseConfirm}
          onConfirm={() => {
            const a = confirm.action;
            onCloseConfirm();
            a();
          }}
        >
          <p className="er-modal-body">{confirm.message}</p>
          <p className="er-modal-body er-confirm-sub">
            {confirm.sub ?? "この操作は元に戻せません"}
          </p>
        </ConfirmDialog>
      )}

      {nameDialog && (
        <ErModal
          title={
            nameDialog.mode === "saveAs" ? "名前を付けて保存" : "図の名前を変更"
          }
          sub="どの接続からでもこの名前で開けます"
          onClose={onCloseName}
          actions={
            <button
              className="btn-primary"
              disabled={!nameDialog.value.trim()}
              onClick={onCommitName}
            >
              {nameDialog.mode === "saveAs" ? "保存する" : "名前を変更する"}
            </button>
          }
        >
          <input
            className="er-modal-input"
            value={nameDialog.value}
            autoFocus
            placeholder="例: 受注まわり"
            onChange={(e) => onChangeName(e.target.value)}
            onKeyDown={(e) => {
              // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
              if (imeBusy(e)) return;
              if (e.key === "Enter") onCommitName();
              else if (e.key === "Escape") onCloseName();
            }}
          />
        </ErModal>
      )}
    </>
  );
}
