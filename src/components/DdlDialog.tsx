import { useEffect, useState } from "react";
import { ModalFrame } from "./ModalFrame";
import { SqlDialogButtons } from "./SqlTextDialog";

interface Props {
  /** 見出しに出すテーブル名 */
  table: string;
  /** CREATE文を取得する */
  onLoad: () => Promise<string>;
  onClose: () => void;
  /** 渡すと「SQLエディタへ送る」を出す */
  onSendToEditor?: (sql: string) => void;
}

/**
 * テーブルの CREATE 文を表示してコピーするための画面。
 * 定義を人に渡したいときに、SQLをその場で書き起こさずに済むようにする
 */
export function DdlDialog({ table, onLoad, onClose, onSendToEditor }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // 前のテーブルの内容が残らないように空にしてから取り直す
    setText("");
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
    // 対象テーブルが変わったときだけ作り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

  return (
    <ModalFrame
      title="CREATE 文"
      target={table}
      onClose={onClose}
      className="cell-modal"
      footer={
        <SqlDialogButtons
          text={busy ? "" : text}
          onClose={onClose}
          onSendToEditor={onSendToEditor}
          onError={setError}
        />
      }
    >
      <div className="cell-modal-body">
        <div className="cell-meta">
          <span className="faint">
            {busy
              ? "読み込み中…"
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
    </ModalFrame>
  );
}
