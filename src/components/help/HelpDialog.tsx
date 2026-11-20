/**
 * ヘルプ。
 *
 * 左で話題を選び、右にその説明を出す。
 * 話題の中身は helpTopics.ts にまとめてあるので、
 * 足すときはこの画面を触らずに済む
 */
import { useMemo, useState } from "react";
import type { DbType } from "../../types";
import { ModalFrame } from "../ModalFrame";
import { SelectMenu } from "../SelectMenu";
import { topicsFor } from "./helpTopics";

interface Props {
  /**
   * つないでいるDB (出す話題と中身が変わる)。
   * 接続する前 (ホーム・⌘K・メニューバーから開いたとき) は省き、画面の中で選んでもらう
   */
  dbType?: DbType;
  onClose: () => void;
}

/** DBの呼び名 (見出しに出して、どちら向けの話かを分かるようにする) */
const DB_LABEL: Record<DbType, string> = {
  mysql: "MySQL / MariaDB",
  postgresql: "PostgreSQL",
  sqlite: "SQLite",
  valkey: "Valkey / Redis",
};

/** 接続していないときに選べるDB */
const DB_OPTIONS = (Object.keys(DB_LABEL) as DbType[]).map((value) => ({
  value,
  label: DB_LABEL[value],
}));

export function HelpDialog({ dbType: fixedDb, onClose }: Props) {
  /** 接続していないときに選んだDB */
  const [pickedDb, setPickedDb] = useState<DbType>("mysql");
  const dbType = fixedDb ?? pickedDb;
  const topics = useMemo(() => topicsFor(dbType), [dbType]);
  const [picked, setPicked] = useState(topics[0]?.id ?? "");

  const current = topics.find((t) => t.id === picked) ?? topics[0] ?? null;

  return (
    <ModalFrame
      title="ヘルプ"
      target={fixedDb ? DB_LABEL[fixedDb] : undefined}
      onClose={onClose}
      className="help-modal"
    >
        <div className="help-body">
          <div className="help-list">
            {/* 接続していないときは、どのDB向けの説明かを選べるようにする */}
            {!fixedDb && (
              <SelectMenu
                value={dbType}
                options={DB_OPTIONS}
                onChange={(v) => setPickedDb(v as DbType)}
              />
            )}
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
    </ModalFrame>
  );
}
