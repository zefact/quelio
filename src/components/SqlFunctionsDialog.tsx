/**
 * SQL関数のリファレンス。
 *
 * 「関数の書き方を忘れて、そのたびにブラウザで調べる」のを無くすための画面。
 * 名前を覚えていなくても引けるよう、説明や「切り捨て」「前ゼロ」といった
 * 言葉でも探せるようにしてある。
 *
 * 開いたまま書き進められるよう、選んだ関数はその場でエディタへ差し込める
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useModal } from "../hooks/useModal";
import { writeClipboard } from "../gridCopy";
import type { DbType } from "../types";
import { functionsFor, searchFunctions } from "../sqlFunctions";
import type { SqlFuncHit } from "../sqlFunctions";
import { CaretIcon } from "./SqlToolIcons";

interface Props {
  dbType: DbType;
  /** エディタへ差し込む (書けない場面では渡さない) */
  onInsert?: (text: string) => void;
  onClose: () => void;
}

/** DBの呼び名 (見出しに出す) */
const DB_LABEL: Record<DbType, string> = {
  mysql: "MySQL",
  postgresql: "PostgreSQL",
  sqlite: "SQLite",
  valkey: "Valkey",
};

export function SqlFunctionsDialog({ dbType, onInsert, onClose }: Props) {
  const boxRef = useModal(onClose);
  const [query, setQuery] = useState("");
  /** 選んでいる関数 (名前で覚える。絞り込みで並びが変わっても追える) */
  const [picked, setPicked] = useState<string | null>(null);
  /** たたんでいる分類 */
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => functionsFor(dbType), [dbType]);
  const hits = useMemo(() => searchFunctions(groups, query), [groups, query]);

  /** 探しているあいだは分類で区切らず、当たった順に出す */
  const showGroups = query.trim() === "";

  /**
   * 今そこに出ている関数の並び。
   *
   * たたんだ分類の中身は出ていないので、↑↓ でも飛ばす
   */
  const shown = useMemo(
    () => (showGroups ? hits.filter((h) => !closed.has(h.category)) : hits),
    [hits, showGroups, closed]
  );

  /** 関数名から、出ている並びの中の位置を引く */
  const positions = useMemo(() => {
    const at = new Map<string, number>();
    shown.forEach((h, i) => at.set(h.func.name, i));
    return at;
  }, [shown]);

  /** 今見ている関数 (選んでいなければ先頭) */
  const current: SqlFuncHit | undefined =
    shown.find((h) => h.func.name === picked) ?? shown[0];

  // 絞り込みが変わったら、選び直しを先頭に戻す
  useEffect(() => {
    setPicked(null);
    listRef.current?.scrollTo({ top: 0 });
  }, [query]);

  const copyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    []
  );

  const copy = async (text: string) => {
    try {
      await writeClipboard(text);
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* コピーできなくても画面は保つ */
    }
  };

  /** 分類をたたむ・開く */
  const toggle = (category: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });

  const openAll = () => setClosed(new Set());
  const closeAll = () => setClosed(new Set(groups.map((g) => g.category)));

  /**
   * 一覧を1つ前・1つ後ろへ動かす。
   *
   * 画面のどこにフォーカスがあっても効くよう、枠ごと拾う。
   * 拾わないと、一覧に当たったキーがそのままスクロールに使われてしまう
   */
  const moveBy = (step: number) => {
    if (shown.length === 0) return;
    const at = current ? (positions.get(current.func.name) ?? 0) : 0;
    const next = Math.min(shown.length - 1, Math.max(0, at + step));
    setPicked(shown[next].func.name);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-at="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  /** 一覧の1件 */
  const item = (h: SqlFuncHit) => (
    <button
      key={`${h.category}:${h.func.name}`}
      className={"fn-item" + (h.func.name === current?.func.name ? " on" : "")}
      data-at={positions.get(h.func.name)}
      onClick={() => setPicked(h.func.name)}
      onDoubleClick={() => onInsert?.(h.func.signature)}
    >
      <span className="fn-item-name mono">{h.func.name}</span>
      <span className="fn-item-sum">{h.func.summary}</span>
    </button>
  );

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal fn-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            moveBy(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            moveBy(-1);
          }
        }}
      >
        <div className="modal-head">
          <span className="modal-title">
            関数リファレンス
            <span className="column-modal-target mono">{DB_LABEL[dbType]}</span>
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        {groups.length === 0 ? (
          <div className="fn-empty">
            {DB_LABEL[dbType]} の関数はまだ用意していません。
            <br />
            今のところ MySQL と PostgreSQL に対応しています。
          </div>
        ) : (
          <div className="fn-body">
            <div className="fn-left">
              <input
                className="fn-search"
                autoFocus
                placeholder="関数名・やりたいこと (例: 切り捨て / 前ゼロ / 月末)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="fn-count">
                <span>
                  {showGroups
                    ? `${hits.length}件`
                    : `${hits.length}件が当てはまりました`}
                </span>
                {showGroups && (
                  <span className="fn-count-actions">
                    <button className="fn-link" onClick={openAll}>
                      すべて開く
                    </button>
                    <button className="fn-link" onClick={closeAll}>
                      すべて閉じる
                    </button>
                  </span>
                )}
              </div>
              <div className="fn-list" ref={listRef}>
                {showGroups
                  ? groups.map((g) => {
                      const off = closed.has(g.category);
                      return (
                        <div key={g.category}>
                          <button
                            className={"fn-cat" + (off ? " off" : "")}
                            aria-expanded={!off}
                            onClick={() => toggle(g.category)}
                          >
                            <span className="fn-cat-caret">
                              <CaretIcon />
                            </span>
                            <span className="fn-cat-name">{g.category}</span>
                            <span className="fn-cat-count">
                              {g.items.length}
                            </span>
                          </button>
                          {!off &&
                            g.items.map((func) =>
                              item({ category: g.category, func })
                            )}
                        </div>
                      );
                    })
                  : hits.map(item)}
                {hits.length === 0 && (
                  <div className="fn-none">
                    見つかりませんでした。
                    <br />
                    別の言い方でも探せます (例: 「連結」「日付」「順位」)
                  </div>
                )}
              </div>
            </div>

            <div className="fn-right">
              {current && (
                <>
                  <div className="fn-title">
                    <span className="mono">{current.func.name}</span>
                    <span className="fn-badge">{current.category}</span>
                    {current.func.since && (
                      <span className="fn-badge since">
                        {current.func.since}〜
                      </span>
                    )}
                  </div>

                  <div className="fn-sum">{current.func.summary}</div>

                  <div className="fn-label">書式</div>
                  <pre className="fn-code mono">{current.func.signature}</pre>

                  <div className="fn-label">例</div>
                  <pre className="fn-code mono">{current.func.example}</pre>

                  <div className="fn-label">結果</div>
                  <pre className="fn-code result mono">{current.func.result}</pre>

                  {current.func.note && (
                    <div className="fn-note">
                      <strong>ここに注意</strong>
                      <span>{current.func.note}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <span className="faint fn-hint">
            項目を2度押しすると書式を差し込みます
          </span>
          <span className="toolbar-spacer" />
          {current && (
            <button
              className="btn-secondary"
              onClick={() => void copy(current.func.example)}
            >
              {copied ? "コピーしました" : "例をコピー"}
            </button>
          )}
          {current && onInsert && (
            <button
              className="btn-primary"
              onClick={() => onInsert(current.func.signature)}
            >
              エディタに差し込む
            </button>
          )}
          {!onInsert && (
            <button className="btn-primary" onClick={onClose}>
              閉じる
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
