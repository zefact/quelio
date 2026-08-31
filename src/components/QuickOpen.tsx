import { useEffect, useMemo, useRef, useState } from "react";
import { useModal } from "../hooks/useModal";
import { badgeStyle, dbBadgeLabel, profileColor } from "../colors";
import { filterActions } from "../quickActions";
import type { QuickAction } from "../quickActions";
import type { ConnectionProfile, FolderInfo } from "../types";

interface Props {
  connections: ConnectionProfile[];
  folders: FolderInfo[];
  /** 打ち込んで呼び出せる操作 (設定・ER図など) */
  actions: QuickAction[];
  /** 選んだ接続先を新しいタブで開く */
  onOpen: (profile: ConnectionProfile) => void;
  onClose: () => void;
}

/** 所属フォルダの名前 (無ければ空) */
function folderName(folders: FolderInfo[], id: string | undefined) {
  return folders.find((f) => f.id === id)?.name ?? "";
}

/**
 * 接続先とアクションを名前で探して実行する画面 (⌘K)。
 *
 * 接続先が増えると一覧から探すのが面倒になるため、打ち込んで絞り込めるようにする。
 * 設定やER図といった操作も同じ入口から呼べる (打ち込んだときだけ出す。
 * 何も打っていないときは、これまで通り接続先だけを並べる)
 */
export function QuickOpen({
  connections,
  folders,
  actions,
  onOpen,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useModal(onClose);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = connections.filter((c) => {
      if (!q) return true;
      return [c.name, c.host, c.database ?? "", c.user, c.dbType].some((v) =>
        v.toLowerCase().includes(q)
      );
    });
    return list.slice(0, 50);
  }, [connections, query]);

  const actionHits = useMemo(
    () => filterActions(actions, query),
    [actions, query]
  );

  /** ↑↓ で動かすための通し番号 (接続先 → アクションの順) */
  const total = hits.length + actionHits.length;
  // 絞り込みで選択が範囲外になったら先頭へ戻す
  const at = index < total ? index : 0;

  // キーで動かしたときに、選択が見えるところへスクロールする
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-at="${at}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const choose = (n: number) => {
    if (n < hits.length) {
      const p = hits[n];
      if (!p) return;
      onOpen(p);
      onClose();
      return;
    }
    const a = actionHits[n - hits.length];
    if (!a || a.disabledReason) return;
    onClose();
    a.run();
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal quick-open"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <input
          ref={inputRef}
          className="quick-input"
          value={query}
          placeholder="接続先やアクションを名前で探す"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, total - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(at);
            }
          }}
        />

        {total === 0 ? (
          <div className="quick-empty">
            {connections.length === 0
              ? "保存された接続先がありません"
              : "該当する接続先・アクションがありません"}
          </div>
        ) : (
          <div className="quick-list" ref={listRef}>
            {hits.length > 0 && (
              <>
                {query.trim() !== "" && (
                  <div className="quick-group">接続先</div>
                )}
                {hits.map((c, i) => {
                  const path = folderName(folders, c.folderId);
                  return (
                    <button
                      key={c.id}
                      data-at={i}
                      className={"quick-item" + (i === at ? " selected" : "")}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => choose(i)}
                    >
                      <span
                        className="db-badge mini"
                        style={badgeStyle(profileColor(c))}
                      >
                        {dbBadgeLabel(c.dbType)}
                      </span>
                      <span className="quick-name">
                        {c.name || `${c.host}:${c.port}`}
                      </span>
                      <span className="quick-sub mono">
                        {c.dbType === "sqlite"
                          ? (c.database ?? "")
                          : `${c.user}@${c.host}:${c.port}${c.database ? ` / ${c.database}` : ""}`}
                      </span>
                      {path && <span className="quick-folder">{path}</span>}
                    </button>
                  );
                })}
              </>
            )}

            {actionHits.length > 0 && (
              <>
                <div className="quick-group">アクション</div>
                {actionHits.map((a, i) => {
                  const n = hits.length + i;
                  return (
                    <button
                      key={a.id}
                      data-at={n}
                      className={
                        "quick-item quick-action" + (n === at ? " selected" : "")
                      }
                      disabled={a.disabledReason !== undefined}
                      title={a.disabledReason}
                      onMouseEnter={() => setIndex(n)}
                      onClick={() => choose(n)}
                    >
                      <span className="quick-action-icon" aria-hidden>
                        ▸
                      </span>
                      <span className="quick-name">{a.label}</span>
                      <span className="quick-sub">
                        {a.disabledReason ?? a.hint ?? ""}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}

        <div className="quick-foot">
          <span className="faint">
            ↑↓ で選択 / Enter で実行 / Esc で閉じる ・
            設定やER図などのアクションも名前で探せます
          </span>
        </div>
      </div>
    </div>
  );
}
