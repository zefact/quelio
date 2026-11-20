import { useEffect, useRef, useState } from "react";
import { applyColumnDdl, previewColumnDdl } from "../api";
import type { ColumnChange, ColumnInfo } from "../types";
import { prodActionText } from "../prodConfirm";
import { ModalFrame } from "./ModalFrame";
import { ProdNote } from "./ProdBadge";

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
  /** 本番の接続か (見出しにバッジと、本文の先頭に本番の1行を出す) */
  prod?: boolean;
}

/**
 * カラム削除の確認。
 * 削除はデータが失われて戻せないため、本番かどうかに関わらず確認を出す
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
  prod = false,
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
    // 開いた時点の内容で1回だけ組み立てる (途中で変わらない)
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


  /** 取り消せない操作なので、開いたときのフォーカスは「キャンセル」に置く */
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const fullName = schema ? `${schema}.${table}` : table;

  return (
    <ModalFrame
      title="カラムを削除します"
      target={`${table}.${column.name}`}
      prod={prod}
      onClose={onClose}
      closable={!busy}
      className="ddl-confirm"
      footerNote={
        sql && sql.length > 0 ? (
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => {
              onSendToEditor(sql.join(";\n") + ";");
              onClose();
            }}
          >
            SQLエディタへ送る
          </button>
        ) : undefined
      }
      footer={
        <>
          <button
            className="btn-secondary"
            onClick={onClose}
            disabled={busy}
            ref={cancelRef}
          >
            キャンセル
          </button>
          <button
            className="btn-danger"
            disabled={busy || !sql || sql.length === 0}
            onClick={apply}
          >
            {busy ? (
              <>
                <span className="spinner light" /> 実行中…
              </>
            ) : (
              "削除する"
            )}
          </button>
        </>
      }
    >
      <div className="column-modal-body">
        {prod && (
          <ProdNote>
            {prodActionText(fullName, `カラム ${column.name} を削除します`)}
          </ProdNote>
        )}
        <p className="column-warn">
          このカラムのデータは失われ、元に戻せません。
        </p>
        <p className="column-note">実行するSQL</p>
        <pre className="column-sql mono">
          {sql === null ? (error ? "" : "組み立て中…") : sql.join(";\n") + ";"}
        </pre>

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
