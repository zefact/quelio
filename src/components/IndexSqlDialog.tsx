/**
 * インデックスの CREATE INDEX 文を出すだけの画面。
 *
 * 実行はしない。別の環境へ同じインデックスを作るときに、
 * 打ち直さず写せるようにするためのもの
 */
import { useState } from "react";
import { useModal } from "../hooks/useModal";
import { writeClipboard } from "../gridCopy";

interface Props {
  /** どのインデックスのものか (見出しに出す) */
  name: string;
  /** 組み立てた文 (取れていなければ null で読み込み中) */
  sql: string[] | null;
  /** 組み立てられなかったときの理由 */
  error: string | null;
  onClose: () => void;
}

export function IndexSqlDialog({ name, sql, error, onClose }: Props) {
  const boxRef = useModal(onClose);
  const [copied, setCopied] = useState(false);
  const text = (sql ?? []).join(";\n");

  const copy = async () => {
    if (!text) return;
    await writeClipboard(`${text};`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal ddl-confirm"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            CREATE INDEX 文
            <span className="column-modal-target mono">{name}</span>
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        {error ? (
          <div className="result-banner ng">
            <span className="dot" aria-hidden />
            <span className="result-detail">{error}</span>
          </div>
        ) : sql === null ? (
          <div className="routine-empty">
            <span className="spinner accent" /> 組み立てています...
          </div>
        ) : (
          <pre className="column-sql mono">{text}</pre>
        )}

        <div className="form-actions">
          <button className="btn-secondary" onClick={onClose}>
            閉じる
          </button>
          <button className="btn-primary" onClick={() => void copy()} disabled={!text}>
            {copied ? "コピーしました" : "コピー"}
          </button>
        </div>
      </div>
    </div>
  );
}
