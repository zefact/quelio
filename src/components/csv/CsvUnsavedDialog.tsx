/**
 * 保存していないCSVを閉じる前の確認。
 *
 * 「保存せずに閉じる」だけだと、保存したいときに一度やめて保存し直す手間がかかる。
 * その場で保存してから閉じられるよう、「保存して閉じる」も並べる
 */
import { useEffect, useRef, useState } from "react";
import { ModalFrame } from "../ModalFrame";

interface Props {
  /** 見出しの右に出す、保存していないファイルの名前 */
  target: string;
  /** 2つ以上のファイルか (文を変える) */
  many: boolean;
  /** 保存してから閉じる。保存できなかった・保存先を選ばなかったら false を返す */
  onSave: () => Promise<boolean>;
  /** 保存せずに閉じる */
  onDiscard: () => void;
  onCancel: () => void;
}

export function CsvUnsavedDialog({
  target,
  many,
  onSave,
  onDiscard,
  onCancel,
}: Props) {
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // 消える側の操作なので、開いたときのフォーカスは「キャンセル」に置く
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const save = async () => {
    setBusy(true);
    const ok = await onSave().catch(() => false);
    // 閉じられなかったときだけ押せるように戻す (閉じたら画面ごと消える)
    if (!ok) setBusy(false);
  };

  return (
    <ModalFrame
      title="保存していない変更があります"
      target={target}
      onClose={onCancel}
      closable={!busy}
      className="ddl-confirm"
      footer={
        <>
          <button
            className="btn-secondary"
            ref={cancelRef}
            disabled={busy}
            onClick={onCancel}
          >
            キャンセル
          </button>
          <button className="btn-ghost danger" disabled={busy} onClick={onDiscard}>
            保存せずに閉じる
          </button>
          <button className="btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? (
              <>
                <span className="spinner light" /> 保存中…
              </>
            ) : (
              "保存して閉じる"
            )}
          </button>
        </>
      }
    >
      <div className="column-modal-body">
        <div className="confirm-body">
          {many
            ? "保存せずに閉じると、これらのファイルへの変更は失われます。"
            : "保存せずに閉じると、このファイルへの変更は失われます。"}
        </div>
      </div>
    </ModalFrame>
  );
}
