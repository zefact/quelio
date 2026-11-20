import { ReactNode, useEffect, useRef, useState } from "react";
import { ModalFrame } from "./ModalFrame";
import { ProdNote } from "./ProdBadge";

interface Props {
  /** 見出し (例: 接続先を削除します) */
  title: string;
  /** 見出しの右に出す対象名 (テーブル名・接続名など) */
  target?: string;
  /** 本文。何が起きるかを書く */
  children: ReactNode;
  /**
   * 実行ボタンのラベル。何をするかを動詞で書く (「削除する」「作り直す」など)。
   * 「OK」のような何をするか分からない言葉は使わない
   */
  confirmLabel: string;
  /** やめるボタンのラベル (既定は「キャンセル」) */
  cancelLabel?: string;
  /**
   * 実行ボタンの色。
   * 赤 (danger) は消す・壊すなど、取り消せない操作だけに使う
   */
  tone?: "danger" | "primary";
  /**
   * 本番接続への操作のときに渡す、何をするかの1行
   * (例: 「本番環境の users のカラムを変更します。」)。
   * 渡すと見出しにバッジを出し、本文の先頭にこの1行を置き、
   * フォーカスを「キャンセル」に置く
   */
  prodNote?: ReactNode;
  /**
   * 開いたときにフォーカスを置く先。
   *
   * 既定は、取り消せない操作 (danger) と本番では「キャンセル」、
   * それ以外は枠 (どのボタンにも当てない)
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
 * 確認ダイアログの共通部品。
 *
 * 削除や本番での変更など、手を止めて確かめたい操作はここを通す。
 * どこも同じ見た目・同じ操作 (Esc / 背景クリックでやめる、
 * ボタンは右に [キャンセル] [実行]) にする
 */
export function ConfirmDialog({
  title,
  target,
  children,
  confirmLabel,
  cancelLabel = "キャンセル",
  tone = "danger",
  prodNote,
  defaultFocus,
  onConfirm,
  onCancel,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const focus =
    defaultFocus ?? (tone === "danger" || prodNote ? "cancel" : "box");
  // 開いたときに1度だけ (枠へ当てた後に取り直す)
  useEffect(() => {
    if (focus === "cancel") cancelRef.current?.focus();
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
    <ModalFrame
      title={title}
      target={target}
      prod={!!prodNote}
      onClose={onCancel}
      closable={!busy}
      className="ddl-confirm"
      footer={
        <>
          <button
            className="btn-secondary"
            onClick={onCancel}
            disabled={busy}
            ref={cancelRef}
          >
            {cancelLabel}
          </button>
          <button
            className={tone === "danger" ? "btn-danger" : "btn-primary"}
            disabled={busy}
            onClick={run}
          >
            {busy ? (
              <>
                <span className="spinner light" /> 実行中…
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </>
      }
    >
      <div className="column-modal-body">
        {prodNote && <ProdNote>{prodNote}</ProdNote>}
        <div className={tone === "danger" ? "column-warn" : "confirm-body"}>
          {children}
        </div>

        {error && (
          <div className="result-banner ng column-error">
            <span className="dot" aria-hidden />
            <strong>エラー</strong>
            <span className="result-detail">{error}</span>
          </div>
        )}
      </div>
    </ModalFrame>
  );
}
