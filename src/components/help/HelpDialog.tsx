/**
 * ヘルプ。
 *
 * 左で話題を選び、右にその説明を出す。
 * 話題の中身は helpTopics.ts にまとめてあるので、
 * 足すときはこの画面を触らずに済む
 */
import { useMemo, useState } from "react";
import { useModal } from "../../hooks/useModal";
import type { DbType } from "../../types";
import { topicsFor } from "./helpTopics";

interface Props {
  /** つないでいるDB (出す話題と中身が変わる) */
  dbType: DbType;
  onClose: () => void;
}

/** DBの呼び名 (見出しに出して、どちら向けの話かを分かるようにする) */
const DB_LABEL: Record<DbType, string> = {
  mysql: "MySQL / MariaDB",
  postgresql: "PostgreSQL",
  sqlite: "SQLite",
  valkey: "Valkey / Redis",
};

export function HelpDialog({ dbType, onClose }: Props) {
  const boxRef = useModal(onClose);
  const topics = useMemo(() => topicsFor(dbType), [dbType]);
  const [picked, setPicked] = useState(topics[0]?.id ?? "");

  const current = topics.find((t) => t.id === picked) ?? topics[0] ?? null;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal help-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            ヘルプ
            <span className="column-modal-target">{DB_LABEL[dbType]}</span>
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        <div className="help-body">
          <div className="help-list">
            {topics.map((t) => (
              <button
                key={t.id}
                className={"help-item" + (t.id === current?.id ? " picked" : "")}
                onClick={() => setPicked(t.id)}
              >
                <span className="help-item-label">{t.label}</span>
                <span className="help-item-note">{t.note}</span>
              </button>
            ))}
          </div>

          <div className="help-detail">
            {current === null ? (
              <div className="csv-empty-hint">
                この接続に出せる説明はまだありません
              </div>
            ) : (
              <>
                <h3 className="help-detail-title">{current.label}</h3>
                {current.sections(dbType).map((s) => (
                  <section key={s.title}>
                    <h4>{s.title}</h4>
                    {s.lines?.map((line) => (
                      <p key={line}>{line}</p>
                    ))}
                    {s.table && (
                      /* 幅が足りないときは、この枠の中だけ横に動かす */
                      <div className="help-table-wrap">
                        <table className="help-table">
                          <thead>
                            <tr>
                              {s.table.head.map((h) => (
                                <th key={h}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {s.table.rows.map((row) => (
                              <tr key={row[0]}>
                                {row.map((cell, i) => (
                                  <td
                                    // 1列目は用語なので、折り返さず等幅で出す
                                    className={i === 0 ? "help-term" : undefined}
                                    key={s.table?.head[i] ?? i}
                                  >
                                    {cell}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
