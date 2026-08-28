import { useEffect, useState } from "react";
import { useModal } from "../hooks/useModal";
import { applyColumnDdl, previewColumnDdl } from "../api";
import type { ColumnChange, ColumnInfo } from "../types";

interface Props {
  sessionId: string;
  database?: string;
  schema?: string;
  table: string;
  column: ColumnInfo;
  onClose: () => void;
  /** 実行が成功したときに呼ばれる (定義の再読み込み用) */
  onApplied: () => void;
  /** 生成したSQLをSQLエディタへ送る */
  onSendToEditor: (sql: string) => void;
}

/**
 * カラム削除の確認。
 * 変更は確認なしで反映するが、削除だけはデータが失われて戻せないため確認を出す
 */
export function DropColumnConfirm({
  sessionId,
  database,
  schema,
  table,
  column,
  onClose,
  onApplied,
  onSendToEditor,
}: Props) {
  const change: ColumnChange = { kind: "drop", name: column.name };
  const [sql, setSql] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    previewColumnDdl(sessionId, schema, table, change)
      .then((s) => alive && setSql(s))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await applyColumnDdl(sessionId, database, schema, table, change);
      onApplied();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };


  // Escで閉じる・初期フォーカスは共通の作法にそろえる
  const boxRef = useModal(onClose);

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
            カラムを削除します
            <span className="column-modal-target mono">
              {table}.{column.name}
            </span>
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる">
            ×
          </button>
        </div>

        <div className="column-modal-body">
          <p className="column-warn">
            このカラムのデータは失われます。取り消しはできません。
          </p>
          <p className="column-note">実行するSQL</p>
          <pre className="column-sql mono">
            {sql === null ? (error ? "" : "組み立て中...") : sql.join(";\n") + ";"}
          </pre>

          {error && (
            <div className="result-banner ng column-error">
              <span className="dot" aria-hidden />
              <strong>エラー</strong>
              <span className="result-detail">{error}</span>
            </div>
          )}
        </div>

        <div className="modal-actions column-modal-actions">
          {sql && sql.length > 0 && (
            <button
              className="btn-secondary"
              onClick={() => {
                onSendToEditor(sql.join(";\n") + ";");
                onClose();
              }}
            >
              SQLエディタへ送る
            </button>
          )}
          <span className="toolbar-spacer" />
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button
            className="btn-danger"
            disabled={busy || !sql || sql.length === 0}
            onClick={apply}
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
