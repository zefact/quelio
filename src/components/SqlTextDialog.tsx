import { useEffect, useRef, useState } from "react";
import { writeClipboard } from "../gridCopy";
import { useModal } from "../hooks/useModal";

interface Props {
  /** 見出し (例: ALTER文) */
  title: string;
  /** 見出しの右に出す対象名 */
  target?: string;
  /** 表示するSQL */
  text: string;
  onClose: () => void;
}

/**
 * 組み立てたSQLを読ませてコピーさせるだけの画面。
 * ここからは実行しない (内容を確かめてからSQLエディタで流す前提)
 */
export function SqlTextDialog({ title, target, text, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const boxRef = useModal(onClose);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );

  const copy = async () => {
    setError(null);
    try {
      await writeClipboard(text);
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("コピーできませんでした");
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal cell-modal"
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
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        <div className="cell-modal-body">
          <div className="cell-meta">
            <span className="faint">
              内容を確かめてから実行してください (この画面では実行しません)
            </span>
          </div>
          <textarea className="cell-text mono" value={text} readOnly />
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
          <button className="btn-secondary" onClick={copy}>
            {copied ? "コピーしました" : "コピー"}
          </button>
          <button className="btn-primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
