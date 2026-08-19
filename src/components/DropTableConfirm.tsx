import { useState } from "react";
import { dropTable } from "../api";
import type { TableInfo } from "../types";

interface Props {
  sessionId: string;
  database?: string;
  table: TableInfo;
  onClose: () => void;
  /** 削除できたときに呼ばれる (一覧の再読み込み用) */
  onDropped: () => void;
}

/** ビューかどうか (見出しの言葉を変えるだけ) */
function label(tableType: string): string {
  return tableType.toUpperCase().includes("VIEW") ? "ビュー" : "テーブル";
}

/**
 * テーブル削除の確認。
 * 他の変更は確認なしで反映するが、削除はデータごと消えて戻せないため確認を出す
 */
export function DropTableConfirm({
  sessionId,
  database,
  table,
  onClose,
  onDropped,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = label(table.tableType);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await dropTable(
        sessionId,
        database,
        table.schema,
        table.name,
        table.tableType
      );
      onDropped();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal ddl-confirm"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        tabIndex={-1}
        ref={(el) => el?.focus()}
      >
        <div className="modal-head">
          <span className="modal-title">
            {kind}を削除します
            <span className="column-modal-target mono">
              {table.schema ? `${table.schema}.` : ""}
              {table.name}
            </span>
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる">
            ×
          </button>
        </div>

        <div className="column-modal-body">
          <p className="column-warn">
            {kind === "ビュー"
              ? "このビューの定義は失われます。取り消しはできません。"
              : "このテーブルのデータと定義は失われます。取り消しはできません。"}
          </p>

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
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button className="btn-danger" disabled={busy} onClick={apply}>
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
