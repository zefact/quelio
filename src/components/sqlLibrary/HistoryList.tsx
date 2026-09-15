/**
 * 実行履歴の一覧 (選ぶ / 1件消す / すべて消す)。
 *
 * 消す操作を足したぶん行が複雑になったので、メニュー本体から分けている
 */
import type { SqlHistoryEntry } from "../../types";
import { previewLine } from "../../sqlLibrarySearch";

/** 実行日時 (MM/DD HH:mm) */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

export function HistoryList({
  entries,
  total,
  query,
  onPick,
  onDelete,
  onClearAll,
}: {
  /** 絞り込んだあとの履歴 */
  entries: SqlHistoryEntry[];
  /** 絞り込む前の件数 (「N件 / 全M件」の表示に使う) */
  total: number;
  /** 探している語 (プレビューを見つかった所に合わせるため) */
  query: string;
  onPick: (sql: string) => void;
  onDelete: (sql: string) => void;
  /** すべて消す (確認は呼び出し側で出す) */
  onClearAll: () => void;
}) {
  if (total === 0) {
    return <div className="history-empty">実行履歴はありません</div>;
  }
  const filtered = entries.length !== total;
  return (
    <>
      <div className="lib-actions">
        <span className="lib-actions-count">
          {filtered ? `${entries.length}件 / 全${total}件` : `${total}件`}
        </span>
        <button className="lib-clear" onClick={onClearAll}>
          すべて消す
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="history-empty">見つかりませんでした</div>
      ) : (
        entries.map((h) => (
          <div className="hist-item-row" key={h.sql}>
            <button
              className="context-item history-item"
              title={h.sql}
              onClick={() => onPick(h.sql)}
            >
              <span className="history-time">{fmtTime(h.executedAtMs)}</span>
              <span className="history-sql mono">
                {previewLine(h.sql, query)}
              </span>
            </button>
            <button
              className="saved-del"
              title="この履歴を消す"
              aria-label="この履歴を消す"
              onClick={() => onDelete(h.sql)}
            >
              ×
            </button>
          </div>
        ))
      )}
    </>
  );
}
