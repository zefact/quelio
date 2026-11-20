import { ModalFrame } from "../ModalFrame";
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
  return (
    <ModalFrame
      title="名前で探す"
      target={database}
      onClose={onClose}
      className="kv-bulk-modal"
    >
        <ObjectSearchPanel
          sessionId={sessionId}
          dbType={dbType}
          database={database}
          onOpen={(h) => {
            onOpenTable(h.database || (database ?? ""), h.schema, h.table);
            onClose();
          }}
        />
    </ModalFrame>
  );
}
