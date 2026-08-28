import { useState } from "react";
import { useModal } from "../../hooks/useModal";
import type { AdminKind } from "./DbAdminDialog";

interface Props {
  /** 「データベース」「スキーマ」 */
  kind: AdminKind;
  /** 消す対象の名前 */
  name: string;
  /** 中身ごと消すかを選ばせるか (PostgreSQLのスキーマ) */
  askCascade?: boolean;
  onCancel: () => void;
  /** 実行する。失敗したら例外を投げること */
  onConfirm: (cascade: boolean) => Promise<void>;
}

/**
 * 名前を打ち込ませてから消す確認。
 *
 * テーブル1つと違って、中身がまるごと消えて戻せないので、
 * 「押し間違い」では実行できないようにする
 */
export function DropNameConfirm({
  kind,
  name,
  askCascade = false,
  onCancel,
  onConfirm,
}: Props) {
  const [typed, setTyped] = useState("");
  const [cascade, setCascade] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useModal(onCancel, !busy);

  const matched = typed === name;

  const run = async () => {
    if (!matched || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(cascade);
    } catch (e) {
      setError(String(e));
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
            {kind}を削除します
            <span className="column-modal-target mono">{name}</span>
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
          <div className="column-warn">
            この{kind}の中身 (テーブル・データ) はすべて消え、元に戻せません。
            <br />
            実行するには、下の欄に <strong className="mono">{name}</strong>{" "}
            と入力してください。
          </div>

          <input
            className="text-field mono db-admin-typed"
            value={typed}
            spellCheck={false}
            autoFocus
            disabled={busy}
            placeholder={name}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              // 日本語入力の変換確定のEnterで消さない
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && matched) void run();
            }}
          />

          {askCascade && (
            <label className="switch db-admin-cascade">
              <input
                type="checkbox"
                checked={cascade}
                disabled={busy}
                onChange={(e) => setCascade(e.target.checked)}
              />
              <span className="track" aria-hidden />
              <span className="switch-label">
                中に何かあっても消す (CASCADE)
              </span>
            </label>
          )}

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
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            キャンセル
          </button>
          <button
            className="btn-danger"
            disabled={busy || !matched}
            onClick={run}
          >
            {busy ? (
              <>
                <span className="spinner light" /> 実行中...
              </>
            ) : (
              "削除する"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
