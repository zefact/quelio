import { useModal } from "../../hooks/useModal";
import { ObjectSearchPanel } from "./ObjectSearchPanel";
import type { DbType } from "../../types";

interface Props {
  sessionId: string;
  dbType: DbType;
  /** 探す対象のデータベース */
  database: string | undefined;
  onClose: () => void;
  /**
   * 見つけたテーブルを開く。
   * データベースが今選んでいるものと違えば、そちらへ切り替えてから開く
   */
  onOpenTable: (database: string, schema: string, table: string) => void;
}

/** テーブル名・カラム名・コメントから探す画面 */
export function SearchDialog({
  sessionId,
  dbType,
  database,
  onClose,
  onOpenTable,
}: Props) {
  const boxRef = useModal(onClose);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal kv-bulk-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            名前で探す
            {database && (
              <span className="column-modal-target mono">{database}</span>
            )}
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        <ObjectSearchPanel
          sessionId={sessionId}
          dbType={dbType}
          database={database}
          onOpen={(h) => {
            onOpenTable(h.database || (database ?? ""), h.schema, h.table);
            onClose();
          }}
        />
      </div>
    </div>
  );
}
