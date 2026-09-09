/**
 * ユーザーへの変更を、実行するSQLを見せてから確かめる画面。
 *
 * 何が起きるかを言葉で書くより、流すSQLをそのまま見せるほうが確かなので、
 * バックエンドに組み立てさせたものを出す
 * (画面で組み立て直すと、実際に流すものとずれる)。
 *
 * 削除だけは名前を打ち込ませる。押し間違いで消えないように
 */
import { useEffect, useState } from "react";
import { applyDbUserChange, previewDbUserChange } from "../../api";
import { useModal } from "../../hooks/useModal";
import type { DbUserChange } from "../../types";

interface Props {
  sessionId: string;
  database: string;
  /** 見出し (「パスワードを変えます」など) */
  title: string;
  /** 見出しの右に出す相手の名前 */
  target: string;
  change: DbUserChange;
  /** 本文に足す注意書き */
  note?: string;
  /** 打ち込ませる名前 (指定すると、合うまで実行できない) */
  typeName?: string;
  confirmLabel?: string;
  /** 実行できたときに呼ぶ (一覧の取り直しなど) */
  onDone: () => void;
  onCancel: () => void;
}

export function ChangeConfirm({
  sessionId,
  database,
  title,
  target,
  change,
  note,
  typeName,
  confirmLabel = "実行する",
  onDone,
  onCancel,
}: Props) {
  const [sql, setSql] = useState<string[] | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useModal(onCancel, !busy);

  // 開いたときに、流すことになるSQLを組み立ててもらう
  useEffect(() => {
    let alive = true;
    previewDbUserChange(sessionId, change)
      .then((v) => alive && setSql(v))
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        // 組み立てられなかったことを示す (待ち続けているように見せない)
        setSql([]);
      });
    return () => {
      alive = false;
    };
    // change は開いている間は変わらない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const matched = !typeName || typed === typeName;
  /** 組み立てられなかったら実行させない */
  const ready = matched && !busy && !!sql?.length;

  const run = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await applyDbUserChange(sessionId, database, change);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const danger = change.kind === "drop";

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
            <span className="column-modal-target mono">{target}</span>
          </span>
          <button className="modal-close" onClick={onCancel} title="閉じる (Esc)">
            ×
          </button>
        </div>

        {note && <p className="dbusers-note">{note}</p>}

        <div className="dbusers-sql">
          <span className="field-label">実行するSQL</span>
          {sql === null ? (
            <div className="routine-empty">
              <span className="spinner accent" /> 組み立てています...
            </div>
          ) : sql.length === 0 ? (
            <div className="csv-empty-hint">組み立てられませんでした</div>
          ) : (
            <pre className="mono">{sql.join(";\n")}</pre>
          )}
        </div>

        {typeName && (
          <label className="dbusers-type">
            <span className="field-label">
              確認のため <b className="mono">{typeName}</b> と入力してください
            </span>
            <input
              className="text-field mono"
              autoFocus
              value={typed}
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) void run();
              }}
            />
          </label>
        )}

        {error && (
          <div className="result-banner ng">
            <span className="dot" aria-hidden />
            <span className="result-detail">{error}</span>
          </div>
        )}

        <div className="form-actions">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            やめる
          </button>
          <button
            className={danger ? "btn-danger" : "btn-primary"}
            onClick={() => void run()}
            disabled={!ready}
          >
            {busy ? "実行中..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
