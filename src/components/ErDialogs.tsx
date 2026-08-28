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

  reverseOpen: boolean;
  onCloseReverse: () => void;
  /** リバース元の表示名 (接続名 / DB名) */
  reverseTarget: string;
  /** 図から削除したテーブルの数 (0なら復活のチェックは出さない) */
  removedCount: number;
  reviveTables: boolean;
  onChangeRevive: (revive: boolean) => void;
  onReverse: (withNewTables: boolean, revive: boolean) => void;

  nameDialog: ErNameDialog | null;
  onChangeName: (value: string) => void;
  onCloseName: () => void;
  onCommitName: () => void;
}

/** ER図ウィンドウのダイアログ3種 (削除確認 / リバース / 名前入力) */
export function ErDialogs({
  confirm,
  onCloseConfirm,
  reverseOpen,
  onCloseReverse,
  reverseTarget,
  removedCount,
  reviveTables,
  onChangeRevive,
  onReverse,
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

      {reverseOpen && (
        <ErModal
          icon="⟳"
          title="リバース"
          sub={reverseTarget}
          subMono
          onClose={onCloseReverse}
          actions={
            <>
              <button
                className="btn-secondary"
                onClick={() => {
                  onCloseReverse();
                  onReverse(false, reviveTables);
                }}
              >
                読み込まない
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  onCloseReverse();
                  onReverse(true, reviveTables);
                }}
              >
                読み込む
              </button>
            </>
          }
        >
          <p className="er-modal-body">
            図に無い新規のテーブルも読み込みますか？
            <br />
            「読み込まない」でも既存テーブルのカラムの増減は反映されます。
          </p>
          {removedCount > 0 && (
            <label className="er-modal-check">
              <input
                type="checkbox"
                checked={reviveTables}
                onChange={(e) => onChangeRevive(e.target.checked)}
              />
              図から削除したテーブル ({removedCount}件) も復活させる
            </label>
          )}
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
