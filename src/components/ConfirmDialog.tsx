import { ReactNode, useEffect, useRef, useState } from "react";
import { useModal } from "../hooks/useModal";

interface Props {
  /** 見出し (例: 接続先を削除します) */
  title: string;
  /** 見出しの右に出す対象名 (テーブル名・接続名など) */
  target?: string;
  /** 本文。何が起きるかを書く */
  children: ReactNode;
  /** 実行ボタンのラベル */
  confirmLabel?: string;
  /** 取り消しボタンのラベル (既定は「キャンセル」) */
  cancelLabel?: string;
  /**
   * 開いたときにフォーカスを置く先。
   *
   * 既定は枠 (どのボタンにも当てない)。
   * 「取り消す」を押しやすくしたいときに `"cancel"` を渡す
   */
  defaultFocus?: "box" | "cancel";
  /**
   * 実行する。失敗したら例外を投げること (メッセージをこのダイアログに出す)。
   * 成功したら呼び出し側で閉じる
   */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * 取り消せない操作の共通確認ダイアログ。
 * 削除系はどこも同じ見た目・同じ操作 (Esc / 背景クリックで中止) にする
 */
export function ConfirmDialog({
  title,
  target,
  children,
  confirmLabel = "削除する",
  cancelLabel = "キャンセル",
  defaultFocus = "box",
  onConfirm,
  onCancel,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Escで閉じる・初期フォーカスは共通の作法にそろえる
  const boxRef = useModal(onCancel, !busy);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // 開いたときに1度だけ (useModal が枠へ当てた後に取り直す)
  useEffect(() => {
    if (defaultFocus === "cancel") cancelRef.current?.focus();
    // 開いた直後だけ。あとから変えない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      // "Error: " が前に付かないようにメッセージだけを取り出す
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={busy ? undefined : onCancel}>
      <div
        className="modal ddl-confirm"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            {title}
            {target && (
              <span className="column-modal-target mono">{target}</span>
            )}
          </span>
          <button
            className="modal-close"
            onClick={onCancel}
            disabled={busy}
            title="閉じる (Esc)"
          >
            ×
          </button>
        </div>

        <div className="column-modal-body">
          <div className="column-warn">{children}</div>

          {error && (
            <div className="result-banner ng column-error">
              <span className="dot" aria-hidden />
              <strong>エラー</strong>
              <span className="result-detail">{error}</span>
            </div>
          )}
        </div>

        <div className="modal-actions column-modal-actions">
          <span className="toolbar-spacer" />
          <button
            className="btn-secondary"
            onClick={onCancel}
            disabled={busy}
            ref={cancelRef}
          >
            {cancelLabel}
          </button>
          <button className="btn-danger" disabled={busy} onClick={run}>
            {busy ? (
              <>
                <span className="spinner light" /> 実行中...
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
