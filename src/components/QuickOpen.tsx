import { useEffect, useMemo, useRef, useState } from "react";
import { useModal } from "../hooks/useModal";
import { badgeStyle, dbBadgeLabel } from "../colors";
import type { ConnectionProfile, FolderInfo } from "../types";

interface Props {
  connections: ConnectionProfile[];
  folders: FolderInfo[];
  /** 選んだ接続先を新しいタブで開く */
  onOpen: (profile: ConnectionProfile) => void;
  onClose: () => void;
}

/** 所属フォルダの名前 (無ければ空) */
function folderName(folders: FolderInfo[], id: string | undefined) {
  return folders.find((f) => f.id === id)?.name ?? "";
}

/**
 * 接続先を名前で探して開く画面 (⌘K)。
 *
 * 接続先が増えると一覧から探すのが面倒になるため、
 * 打ち込んで絞り込めるようにする
 */
export function QuickOpen({ connections, folders, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
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

  // 絞り込みで選択が範囲外になったら先頭へ戻す
  const at = index < hits.length ? index : 0;

  // キーで動かしたときに、選択が見えるところへスクロールする
  useEffect(() => {
    const el = listRef.current?.children[at] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const choose = (p: ConnectionProfile | undefined) => {
    if (!p) return;
    onOpen(p);
    onClose();
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
          placeholder="接続先を名前・ホスト・DB名で探す"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, hits.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(hits[at]);
            }
          }}
        />

        {hits.length === 0 ? (
          <div className="quick-empty">
            {connections.length === 0
              ? "保存された接続先がありません"
              : "該当する接続先がありません"}
          </div>
        ) : (
          <ul className="quick-list" ref={listRef}>
            {hits.map((c, i) => {
              const path = folderName(folders, c.folderId);
              return (
                <li key={c.id}>
                  <button
                    className={"quick-item" + (i === at ? " selected" : "")}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => choose(c)}
                  >
                    <span className="db-badge mini" style={badgeStyle(c.color)}>
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
                </li>
              );
            })}
          </ul>
        )}

        <div className="quick-foot">
          <span className="faint">
            ↑↓ で選択 / Enter で新しいタブに開く / Esc で閉じる
          </span>
        </div>
      </div>
    </div>
  );
}
