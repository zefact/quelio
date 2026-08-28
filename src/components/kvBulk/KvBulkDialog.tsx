import { useState } from "react";
import { useModal } from "../../hooks/useModal";
import { KvDeletePanel } from "./KvDeletePanel";
import { KvSearchPanel } from "./KvSearchPanel";

type Tab = "search" | "delete";

interface Props {
  sessionId: string;
  database: string;
  /** キーブラウザで使っているパターン (初期値) */
  initialPattern: string;
  readOnly: boolean;
  onClose: () => void;
  /** 削除が終わったらキー一覧を取り直す */
  onDeleted: () => void;
  /** 検索で見つけたキーを開く */
  onPickKey: (key: string) => void;
}

/** キーの一括削除と値検索をまとめた画面 */
export function KvBulkDialog({
  sessionId,
  database,
  initialPattern,
  readOnly,
  onClose,
  onDeleted,
  onPickKey,
}: Props) {
  const [tab, setTab] = useState<Tab>("search");
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
            キーの検索・一括削除
            <span className="column-modal-target mono">DB {database}</span>
          </span>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={busy}
            title={busy ? "処理中は閉じられません" : "閉じる (Esc)"}
          >
            ×
          </button>
        </div>

        <div className="kv-bulk-tabs">
          <button
            className={"kv-bulk-tab" + (tab === "search" ? " active" : "")}
            disabled={busy}
            onClick={() => setTab("search")}
          >
            値の検索
          </button>
          <button
            className={"kv-bulk-tab" + (tab === "delete" ? " active" : "")}
            disabled={busy}
            onClick={() => setTab("delete")}
          >
            一括削除
          </button>
        </div>

        {/*
         * 表示を切り替えるだけで作り直さない。
         * 検索結果を見ながら削除タブへ行って戻る、が普通の使い方のため
         */}
        <div hidden={tab !== "search"}>
          <KvSearchPanel
            sessionId={sessionId}
            database={database}
            initialPattern={initialPattern}
            onPickKey={(k) => {
              onPickKey(k);
              onClose();
            }}
            onBusyChange={setBusy}
          />
        </div>
        <div hidden={tab !== "delete"}>
          <KvDeletePanel
            sessionId={sessionId}
            database={database}
            initialPattern={initialPattern}
            readOnly={readOnly}
            onDeleted={onDeleted}
            onBusyChange={setBusy}
          />
        </div>
      </div>
    </div>
  );
}
