import { ErModal } from "./ErModal";

/** 削除の確認 (何を消すかは呼び出し側が決める) */
export interface ErConfirm {
  title: string;
  message: string;
  sub?: string;
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

/** ER図ウィンドウのダイアログ2種 (削除確認 / 名前入力) */
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
        <ErModal
          icon="✕"
          danger
          title={confirm.title}
          sub={confirm.sub ?? "この操作は元に戻せません"}
          onClose={onCloseConfirm}
          actions={
            <button
              className="btn-primary btn-fill-danger"
              autoFocus
              onClick={() => {
                const a = confirm.action;
                onCloseConfirm();
                a();
              }}
            >
              削除する
            </button>
          }
        >
          <p className="er-modal-body">{confirm.message}</p>
        </ErModal>
      )}

      {nameDialog && (
        <ErModal
          icon="✎"
          title={
            nameDialog.mode === "saveAs" ? "名前を付けて保存" : "名前を変更"
          }
          sub="どの接続からでもこの名前で開けます"
          onClose={onCloseName}
          actions={
            <button
              className="btn-primary"
              disabled={!nameDialog.value.trim()}
              onClick={onCommitName}
            >
              保存
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
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") onCommitName();
              else if (e.key === "Escape") onCloseName();
            }}
          />
        </ErModal>
      )}
    </>
  );
}
