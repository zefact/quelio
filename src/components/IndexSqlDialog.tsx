/**
 * インデックスの CREATE INDEX 文を出すだけの画面。
 *
 * 実行はしない。別の環境へ同じインデックスを作るときに、
 * 打ち直さず写せるようにするためのもの
 */
import { useState } from "react";
import { ModalFrame } from "./ModalFrame";
import { SqlDialogButtons } from "./SqlTextDialog";

interface Props {
  /** どのインデックスのものか (見出しに出す) */
  name: string;
  /** 組み立てた文 (取れていなければ null で読み込み中) */
  sql: string[] | null;
  /** 組み立てられなかったときの理由 */
  error: string | null;
  onClose: () => void;
  /** 渡すと「SQLエディタへ送る」を出す */
  onSendToEditor?: (sql: string) => void;
}

export function IndexSqlDialog({
  name,
  sql,
  error,
  onClose,
  onSendToEditor,
}: Props) {
  const [copyError, setCopyError] = useState<string | null>(null);
  const body = (sql ?? []).join(";\n");
  /** コピー・送るときは文の終わりに ; を付ける */
  const text = body ? `${body};` : "";
  const shownError = error ?? copyError;

  return (
    <ModalFrame
      title="CREATE INDEX 文"
      target={name}
      onClose={onClose}
      className="ddl-confirm"
      footer={
        <SqlDialogButtons
          text={text}
          onClose={onClose}
          onSendToEditor={onSendToEditor}
          onError={setCopyError}
        />
      }
    >
      <div className="column-modal-body">
        {sql === null && !error ? (
          <div className="routine-empty">
            <span className="spinner accent" /> 組み立てています…
          </div>
        ) : (
          sql !== null && <pre className="column-sql mono">{body}</pre>
        )}
        {shownError && (
          <div className="result-banner ng column-error">
            <span className="dot" aria-hidden />
            <span className="result-detail">{shownError}</span>
          </div>
        )}
      </div>
    </ModalFrame>
  );
}
