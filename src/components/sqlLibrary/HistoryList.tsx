/**
 * 実行履歴の一覧 (選ぶ / 1件消す / すべて消す)。
 *
 * 消す操作を足したぶん行が複雑になったので、メニュー本体から分けている
 */
import type { SqlHistoryEntry } from "../../types";

/** 1行プレビュー (長いSQLは先頭だけ) */
function preview(sql: string): string {
  const line = sql.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/** 実行日時 (MM/DD HH:mm) */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

export function HistoryList({
  entries,
  onPick,
  onDelete,
  onClearAll,
}: {
  entries: SqlHistoryEntry[];
  onPick: (sql: string) => void;
  onDelete: (sql: string) => void;
  /** すべて消す (確認は呼び出し側で出す) */
  onClearAll: () => void;
}) {
  if (entries.length === 0) {
    return <div className="history-empty">実行履歴はありません</div>;
  }
  return (
    <>
      <div className="lib-actions">
        <span className="lib-actions-count">{entries.length}件</span>
        <button className="lib-clear" onClick={onClearAll}>
          すべて消す
        </button>
      </div>
      {entries.map((h) => (
        <div className="hist-item-row" key={h.sql}>
          <button
            className="context-item history-item"
            title={h.sql}
            onClick={() => onPick(h.sql)}
          >
            <span className="history-time">{fmtTime(h.executedAtMs)}</span>
            <span className="history-sql mono">{preview(h.sql)}</span>
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
      ))}
    </>
  );
}
