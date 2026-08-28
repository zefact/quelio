import { useState } from "react";
import { useModal } from "../../hooks/useModal";
import { ObjectSearchPanel } from "./ObjectSearchPanel";
import { ValueSearchPanel } from "./ValueSearchPanel";
import type { DbType } from "../../types";

type Tab = "name" | "value";

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

/** 名前と値の2通りで探す画面 */
export function SearchDialog({
  sessionId,
  dbType,
  database,
  onClose,
  onOpenTable,
}: Props) {
  const [tab, setTab] = useState<Tab>("name");
  /** 実行中は閉じさせない (中止する手立てを画面に残しておく) */
  const [busy, setBusy] = useState(false);
  const boxRef = useModal(onClose, !busy);

  return (
    <div className="modal-overlay" onMouseDown={busy ? undefined : onClose}>
      <div
        className="modal kv-bulk-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            検索
            {database && (
              <span className="column-modal-target mono">{database}</span>
            )}
          </span>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={busy}
            title={busy ? "検索中は閉じられません" : "閉じる (Esc)"}
          >
            ×
          </button>
        </div>

        <div className="kv-bulk-tabs">
          <button
            className={"kv-bulk-tab" + (tab === "name" ? " active" : "")}
            disabled={busy}
            onClick={() => setTab("name")}
          >
            名前で探す
          </button>
          <button
            className={"kv-bulk-tab" + (tab === "value" ? " active" : "")}
            disabled={busy}
            onClick={() => setTab("value")}
          >
            値で探す
          </button>
        </div>

        {/* 表示を切り替えるだけで作り直さない (結果を見ながら行き来できるように) */}
        <div hidden={tab !== "name"}>
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
        <div hidden={tab !== "value"}>
          <ValueSearchPanel
            sessionId={sessionId}
            dbType={dbType}
            database={database}
            onOpen={(h) => {
              onOpenTable(database ?? "", h.schema, h.table);
              onClose();
            }}
            onBusyChange={setBusy}
          />
        </div>
      </div>
    </div>
  );
}
