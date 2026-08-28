import { useEffect, useMemo, useRef, useState } from "react";
import { listRoutines } from "../api";
import { writeClipboard } from "../gridCopy";
import { useModal } from "../hooks/useModal";
import type { RoutineInfo } from "../types";

interface Props {
  sessionId: string;
  database: string;
  onClose: () => void;
}

/**
 * 関数・プロシージャ・トリガの定義を読むための画面。
 *
 * テーブル一覧には出てこないが、挙動を追うときに定義を見たくなる。
 * 表示するだけで実行はしない
 */
export function RoutineDialog({ sessionId, database, onClose }: Props) {
  const [list, setList] = useState<RoutineInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const boxRef = useModal(onClose);

  useEffect(() => {
    let alive = true;
    listRoutines(sessionId, database)
      .then((v) => {
        if (alive) setList(v);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [sessionId, database]);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    []
  );

  /** 名前・種別・補足のどれかに一致するものだけ出す */
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = list ?? [];
    if (!q) return all;
    return all.filter((r) =>
      [r.name, r.kind, r.detail, r.schema].some((v) =>
        v.toLowerCase().includes(q)
      )
    );
  }, [list, filter]);

  // 絞り込みで選択が範囲外になったら先頭へ戻す
  const index = selected < shown.length ? selected : 0;
  const current = shown[index];

  const copy = async () => {
    if (!current) return;
    setError(null);
    try {
      await writeClipboard(current.definition);
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("コピーできませんでした");
    }
  };

  const fullName = (r: RoutineInfo) =>
    r.schema ? `${r.schema}.${r.name}` : r.name;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal routine-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            関数・トリガの定義
            <span className="column-modal-target mono">{database}</span>
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        <div className="routine-body">
          <div className="routine-list">
            <input
              className="routine-filter"
              value={filter}
              placeholder="絞り込み"
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
            />
            {list === null && !error ? (
              <div className="routine-empty">
                <span className="spinner accent" /> 読み込み中...
              </div>
            ) : shown.length === 0 ? (
              <div className="routine-empty">
                {list && list.length === 0
                  ? "このデータベースには関数・プロシージャ・トリガがありません"
                  : "該当なし"}
              </div>
            ) : (
              <ul>
                {shown.map((r, i) => (
                  <li key={`${r.kind}:${r.schema}:${r.name}:${i}`}>
                    <button
                      className={
                        "routine-item" + (i === index ? " selected" : "")
                      }
                      onClick={() => setSelected(i)}
                    >
                      <span className="type-chip mini view">{r.kind}</span>
                      <span className="routine-name mono">{fullName(r)}</span>
                      {r.detail && (
                        <span className="routine-detail" title={r.detail}>
                          {r.detail}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="routine-def">
            <div className="cell-meta">
              <span className="faint">
                {current
                  ? `${current.kind}: ${fullName(current)} (表示するだけで実行はしません)`
                  : "左の一覧から選んでください"}
              </span>
            </div>
            <textarea
              className="cell-text mono"
              value={current?.definition ?? ""}
              readOnly
            />
          </div>
        </div>

        {error && (
          <div className="result-banner ng column-error">
            <span className="dot" aria-hidden />
            <strong>エラー</strong>
            <span className="result-detail">{error}</span>
          </div>
        )}

        <div className="modal-actions column-modal-actions">
          <span className="faint routine-note">
            検索対象は今つながっているスキーマです (種類ごとに500件まで)
          </span>
          <span className="toolbar-spacer" />
          <button className="btn-secondary" onClick={copy} disabled={!current}>
            {copied ? "コピーしました" : "定義をコピー"}
          </button>
          <button className="btn-primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
