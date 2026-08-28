import { useState } from "react";
import { useModal } from "../hooks/useModal";
import { dropTable } from "../api";
import type { TableInfo } from "../types";

interface Props {
  sessionId: string;
  database?: string;
  /** 消す対象 (複数選択のときは選んだぶんすべて) */
  tables: TableInfo[];
  onClose: () => void;
  /** 1件でも消せたときに呼ばれる (一覧の再読み込み用) */
  onDropped: () => void;
}

/** ビューかどうか (見出しの言葉を変えるだけ) */
function isView(tableType: string): boolean {
  return tableType.toUpperCase().includes("VIEW");
}

/** 表示用の名前 (スキーマがあれば付ける) */
function fullName(t: TableInfo): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

/**
 * テーブル削除の確認。
 *
 * 他の変更は確認なしで反映するが、削除はデータごと消えて戻せないため確認を出す。
 * まとめて消すときは、対象を全部見せたうえで、
 * さらにチェックを1つ入れてもらう (押し間違いで何十件も消えないように)
 */
export function DropTableConfirm({
  sessionId,
  database,
  tables,
  onClose,
  onDropped,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const multi = tables.length > 1;
  const kind = tables.every((t) => isView(t.tableType))
    ? "ビュー"
    : tables.some((t) => isView(t.tableType))
      ? "テーブル・ビュー"
      : "テーブル";

  const apply = async () => {
    setBusy(true);
    setError(null);
    /*
     * 1件ずつ消す。途中で失敗しても、そこまでに消えたぶんは戻せないので、
     * 残りも試したうえで「何が消えて何が残ったか」を伝える
     */
    const failed: string[] = [];
    let done = 0;
    for (const t of tables) {
      try {
        await dropTable(sessionId, database, t.schema, t.name, t.tableType);
        done += 1;
      } catch (e) {
        failed.push(`${fullName(t)}: ${e}`);
      }
    }
    if (done > 0) onDropped();
    if (failed.length === 0) {
      onClose();
      return;
    }
    setError(
      `${done}件を削除しました。${failed.length}件は削除できませんでした。\n` +
        failed.join("\n")
    );
    setBusy(false);
  };

  // Escで閉じる・初期フォーカスは共通の作法にそろえる
  const boxRef = useModal(onClose, !busy);

  return (
    <div className="modal-overlay" onMouseDown={busy ? undefined : onClose}>
      <div
        className="modal ddl-confirm"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            {kind}を削除します
            {multi ? (
              <span className="column-modal-target">{tables.length}件</span>
            ) : (
              <span className="column-modal-target mono">
                {fullName(tables[0])}
              </span>
            )}
          </span>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={busy}
            title="閉じる"
          >
            ×
          </button>
        </div>

        <div className="column-modal-body">
          <p className="column-warn">
            {kind === "ビュー"
              ? "定義は失われます。取り消しはできません。"
              : "データと定義は失われます。取り消しはできません。"}
          </p>

          {multi && (
            <>
              <ul className="drop-table-list mono">
                {tables.map((t) => (
                  <li key={fullName(t)}>{fullName(t)}</li>
                ))}
              </ul>
              <label className="switch drop-table-agree">
                <input
                  type="checkbox"
                  checked={agreed}
                  disabled={busy}
                  onChange={(e) => setAgreed(e.target.checked)}
                />
                <span className="track" aria-hidden />
                <span className="switch-label">
                  上の{tables.length}件すべてを削除します
                </span>
              </label>
            </>
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
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button
            className="btn-danger"
            disabled={busy || (multi && !agreed)}
            onClick={apply}
          >
            {busy ? (
              <>
                <span className="spinner light" /> 実行中...
              </>
            ) : multi ? (
              `${tables.length}件を削除する`
            ) : (
              "削除する"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
