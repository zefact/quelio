import { useEffect, useRef, useState } from "react";
import { useModal } from "../hooks/useModal";
import { writeClipboard } from "../gridCopy";

interface Props {
  /** 見出しに出すテーブル名 */
  table: string;
  /** CREATE文を取得する */
  onLoad: () => Promise<string>;
  onClose: () => void;
}

/**
 * テーブルの CREATE 文を表示してコピーするための画面。
 * 定義を人に渡したいときに、SQLをその場で書き起こさずに済むようにする
 */
export function DdlDialog({ table, onLoad, onClose }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const boxRef = useModal(onClose);

  useEffect(() => {
    let alive = true;
    // 前のテーブルの内容が残らないように空にしてから取り直す
    setText("");
    setCopied(false);
    setBusy(true);
    setError(null);
    onLoad()
      .then((sql) => {
        if (alive) setText(sql);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

  const copyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    []
  );

  const copy = async () => {
    setError(null);
    try {
      await writeClipboard(text);
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
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
            CREATE 文<span className="column-modal-target mono">{table}</span>
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        <div className="cell-modal-body">
          <div className="cell-meta">
            <span className="faint">
              {busy
                ? "取得中..."
                : "サーバーから取得した現在の定義です (実行はしません)"}
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
          <button className="btn-secondary" onClick={copy} disabled={busy || !text}>
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
