import { useEffect, useMemo, useRef, useState } from "react";
import { badgeStyle, PRESET_COLORS } from "../colors";
import { useResizableWidth } from "../hooks/useResizableWidth";
import type {
  ConnectionProfile,
  ConnectionStore,
  FolderInfo,
  LayoutEntry,
  WorkTab,
} from "../types";
import { ConnectionForm } from "./ConnectionForm";

interface Props {
  tab: WorkTab;
  store: ConnectionStore;
  onCreateFolder: () => Promise<FolderInfo | null>;
  onDeleteFolder: (id: string) => void;
  onLayout: (folders: FolderInfo[], order: LayoutEntry[]) => void;
  /** 接続のアイコン色を変更 (undefinedで既定色に戻す) */
  onSetConnColor: (id: string, color: string | undefined) => void;
  onChangeProfile: (profile: ConnectionProfile) => void;
  onSelectFavorite: (profile: ConnectionProfile) => void;
  onNewFavorite: () => void;
  onSave: () => void;
  onDelete: () => void;
  onTest: () => void;
  onConnect: (profile: ConnectionProfile) => void;
}

type DragItem = { type: "conn" | "folder"; id: string };
type DropTarget =
  | { type: "conn-before"; id: string }
  | { type: "folder-before"; id: string }
  | { type: "into-folder"; id: string }
  | { type: "root-end" };

interface MenuState {
  x: number;
  y: number;
  target:
    | { kind: "blank" }
    | { kind: "folder"; id: string }
    | { kind: "conn"; id: string };
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d={
          open
            ? "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H5.5L3 16V7Zm0 9 2.2-6H22l-2.4 6.7A2 2 0 0 1 17.7 18H5a2 2 0 0 1-2-2Z"
            : "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        }
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 未接続タブの中身: 保存済み接続の一覧(フォルダ+D&D対応) + 編集フォーム */
export function ConnectionPicker({
  tab,
  store,
  onCreateFolder,
  onDeleteFolder,
  onLayout,
  onSetConnColor,
  onChangeProfile,
  onSelectFavorite,
  onNewFavorite,
  onSave,
  onDelete,
  onTest,
  onConnect,
}: Props) {
  const { profile, testResult, error, busy } = tab;
  const [sideWidth, startResize] = useResizableWidth(272, 200, 480);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const dragItem = useRef<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const { folders, connections } = store;

  const childrenOf = useMemo(() => {
    const map = new Map<string, ConnectionProfile[]>();
    for (const f of folders) map.set(f.id, []);
    for (const c of connections) {
      if (c.folderId && map.has(c.folderId)) {
        map.get(c.folderId)!.push(c);
      }
    }
    return map;
  }, [folders, connections]);

  const rootConnections = useMemo(
    () =>
      connections.filter((c) => !c.folderId || !childrenOf.has(c.folderId)),
    [connections, childrenOf]
  );

  // メニューは画面のどこかをクリックしたら閉じる
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  // ---------- 並び順の保存 ----------

  /** 現在の表示順を LayoutEntry[] にする */
  const currentEntries = (): LayoutEntry[] => {
    const entries: LayoutEntry[] = [];
    for (const f of folders) {
      for (const c of childrenOf.get(f.id) ?? []) {
        entries.push({ id: c.id, folderId: f.id });
      }
    }
    for (const c of rootConnections) {
      entries.push({ id: c.id, folderId: undefined });
    }
    return entries;
  };

  const moveConnection = (connId: string, target: DropTarget) => {
    const entries = currentEntries().filter((e) => e.id !== connId);
    const conn = connections.find((c) => c.id === connId);
    if (!conn) return;

    if (target.type === "conn-before") {
      const idx = entries.findIndex((e) => e.id === target.id);
      if (idx < 0) return;
      entries.splice(idx, 0, { id: connId, folderId: entries[idx].folderId });
    } else if (target.type === "into-folder") {
      // フォルダ内の末尾へ
      let last = -1;
      entries.forEach((e, i) => {
        if (e.folderId === target.id) last = i;
      });
      const insertAt =
        last >= 0
          ? last + 1
          : entries.length - rootConnections.filter((c) => c.id !== connId).length;
      entries.splice(insertAt, 0, { id: connId, folderId: target.id });
    } else {
      // ルート末尾へ
      entries.push({ id: connId, folderId: undefined });
    }
    onLayout(folders, entries);
  };

  const moveFolder = (folderId: string, beforeId: string | null) => {
    const rest = folders.filter((f) => f.id !== folderId);
    const moving = folders.find((f) => f.id === folderId);
    if (!moving) return;
    if (beforeId === null) {
      rest.push(moving);
    } else {
      const idx = rest.findIndex((f) => f.id === beforeId);
      if (idx < 0) return;
      rest.splice(idx, 0, moving);
    }
    onLayout(rest, currentEntries());
  };

  const toggleFolder = (id: string) => {
    onLayout(
      folders.map((f) => (f.id === id ? { ...f, collapsed: !f.collapsed } : f)),
      currentEntries()
    );
  };

  const commitRename = () => {
    if (renamingId) {
      const name = renameText.trim() || "(無名)";
      onLayout(
        folders.map((f) => (f.id === renamingId ? { ...f, name } : f)),
        currentEntries()
      );
    }
    setRenamingId(null);
  };

  const startCreateFolder = async () => {
    setMenu(null);
    const folder = await onCreateFolder();
    if (folder) {
      setRenamingId(folder.id);
      setRenameText(folder.name);
    }
  };

  /** メニュー対象のアイコン色を変更 */
  const applyColor = (color: string | undefined) => {
    if (!menu) return;
    if (menu.target.kind === "folder") {
      const id = menu.target.id;
      onLayout(
        folders.map((f) => (f.id === id ? { ...f, color } : f)),
        currentEntries()
      );
    } else if (menu.target.kind === "conn") {
      onSetConnColor(menu.target.id, color);
    }
    setMenu(null);
  };

  // ---------- D&D ----------

  /** WebKitではsetDataを呼ばないとドラッグが開始されない */
  const handleDragStart = (e: React.DragEvent, item: DragItem) => {
    dragItem.current = item;
    e.dataTransfer.setData("text/plain", item.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragEnd = () => {
    dragItem.current = null;
    setDropTarget(null);
  };

  const handleDrop = (e: React.DragEvent, target: DropTarget) => {
    e.preventDefault();
    e.stopPropagation();
    const item = dragItem.current;
    dragItem.current = null;
    setDropTarget(null);
    if (!item) return;

    if (item.type === "conn") {
      if (target.type === "folder-before") {
        // 接続をフォルダの前に落とした場合はフォルダ内へ
        moveConnection(item.id, { type: "into-folder", id: target.id });
      } else {
        moveConnection(item.id, target);
      }
    } else if (item.type === "folder") {
      if (target.type === "folder-before") {
        moveFolder(item.id, target.id);
      } else if (target.type === "root-end") {
        moveFolder(item.id, null);
      }
    }
  };

  const dragOver = (e: React.DragEvent, target: DropTarget) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropTarget((cur) =>
      JSON.stringify(cur) === JSON.stringify(target) ? cur : target
    );
  };

  // ---------- 右クリックメニュー ----------

  const openMenu = (e: React.MouseEvent, target: MenuState["target"]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  };

  // ---------- 描画 ----------

  const renderConnItem = (c: ConnectionProfile) => (
    <li key={c.id}>
      <button
        className={
          "connection-item" +
          (c.id === profile.id ? " selected" : "") +
          (dropTarget?.type === "conn-before" && dropTarget.id === c.id
            ? " drop-before"
            : "")
        }
        draggable
        onDragStart={(e) => handleDragStart(e, { type: "conn", id: c.id })}
        onDragEnd={handleDragEnd}
        onDragOver={(e) => dragOver(e, { type: "conn-before", id: c.id })}
        onDrop={(e) => handleDrop(e, { type: "conn-before", id: c.id })}
        onClick={() => onSelectFavorite(c)}
        onDoubleClick={() => onConnect(c)}
        onContextMenu={(e) => openMenu(e, { kind: "conn", id: c.id })}
        title="クリック: 選択 / ダブルクリック: 接続"
      >
        <span className={`db-badge ${c.dbType}`} style={badgeStyle(c.color)}>
          {c.dbType === "mysql" ? "My" : "Pg"}
        </span>
        <span className="connection-info">
          <span className="connection-name">{c.name || "(無名)"}</span>
          <span className="connection-host">
            {c.ssh?.enabled && <span className="ssh-chip">SSH</span>}
            {c.host}:{c.port}
          </span>
        </span>
      </button>
    </li>
  );

  return (
    <div className="picker">
      {/* 保存済み接続一覧 */}
      <aside className="picker-side" style={{ width: sideWidth }}>
        <div className="picker-side-head">
          <span className="picker-side-title">接続先</span>
          <span className="panel-count">{connections.length}</span>
          <span className="toolbar-spacer" />
          <button
            className="pane-icon-btn has-tooltip tooltip-left"
            data-tooltip="新規接続先を作成"
            onClick={onNewFavorite}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12 5v14M5 12h14"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div
          className="connection-tree"
          onContextMenu={(e) => openMenu(e, { kind: "blank" })}
          onDragOver={(e) => dragOver(e, { type: "root-end" })}
          onDrop={(e) => handleDrop(e, { type: "root-end" })}
        >
          <ul className="connection-list">
            {folders.map((f) => {
              const children = childrenOf.get(f.id) ?? [];
              return (
                <li key={f.id}>
                  <button
                    className={
                      "folder-item" +
                      (dropTarget?.type === "folder-before" &&
                      dropTarget.id === f.id
                        ? " drop-before"
                        : "") +
                      (dropTarget?.type === "into-folder" &&
                      dropTarget.id === f.id
                        ? " drop-into"
                        : "")
                    }
                    draggable={renamingId !== f.id}
                    onDragStart={(e) =>
                      handleDragStart(e, { type: "folder", id: f.id })
                    }
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) =>
                      dragOver(
                        e,
                        dragItem.current?.type === "conn"
                          ? { type: "into-folder", id: f.id }
                          : { type: "folder-before", id: f.id }
                      )
                    }
                    onDrop={(e) =>
                      handleDrop(
                        e,
                        dragItem.current?.type === "conn"
                          ? { type: "into-folder", id: f.id }
                          : { type: "folder-before", id: f.id }
                      )
                    }
                    onClick={() => toggleFolder(f.id)}
                    onContextMenu={(e) =>
                      openMenu(e, { kind: "folder", id: f.id })
                    }
                  >
                    <span
                      className={"chevron" + (f.collapsed ? "" : " open")}
                      aria-hidden
                    >
                      ▸
                    </span>
                    <span className="folder-icon" style={badgeStyle(f.color)}>
                      <FolderIcon open={!f.collapsed} />
                    </span>
                    {renamingId === f.id ? (
                      <input
                        className="folder-rename mono"
                        value={renameText}
                        autoFocus
                        onChange={(e) => setRenameText(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename();
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="folder-name">{f.name}</span>
                    )}
                    <span className="folder-count">{children.length}</span>
                  </button>
                  {!f.collapsed && children.length > 0 && (
                    <ul className="connection-list folder-children">
                      {children.map(renderConnItem)}
                    </ul>
                  )}
                </li>
              );
            })}
            {rootConnections.map(renderConnItem)}
            {connections.length === 0 && folders.length === 0 && (
              <li className="connection-empty">
                保存済みの接続先がありません。
                <br />
                右のフォームから作成してください。
                <br />
                <span className="hint">右クリックでフォルダを作成できます</span>
              </li>
            )}
          </ul>
          <div
            className={
              "root-drop-area" +
              (dropTarget?.type === "root-end" ? " drop-into" : "")
            }
          />
        </div>

      </aside>

      <div className="pane-splitter" onMouseDown={startResize} />

      {/* 編集フォーム */}
      <div className="picker-main">
        <header className="main-head">
          <h1>{profile.id ? "接続の編集" : "新しい接続"}</h1>
          {profile.id && <span className="profile-id mono">{profile.name}</span>}
        </header>

        <ConnectionForm
          profile={profile}
          onChange={onChangeProfile}
          onSave={onSave}
          onDelete={onDelete}
          onTest={onTest}
          onConnect={() => onConnect(profile)}
          testing={busy === "test"}
          saving={busy === "save"}
          connecting={busy === "connect"}
        />

        {testResult && (
          <div className={`result-banner ${testResult.success ? "ok" : "ng"}`}>
            <span className="dot" aria-hidden />
            <strong>{testResult.success ? "接続成功" : "接続失敗"}</strong>
            <span className="result-detail">
              {testResult.message}
              {testResult.serverVersion && (
                <span className="mono"> — {testResult.serverVersion}</span>
              )}
              <span className="elapsed">{testResult.elapsedMs}ms</span>
            </span>
          </div>
        )}
        {error && (
          <div className="result-banner ng">
            <span className="dot" aria-hidden />
            <strong>エラー</strong>
            <span className="result-detail">{error}</span>
          </div>
        )}
      </div>

      {/* 右クリックメニュー */}
      {menu && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="context-item"
            onClick={() => {
              setMenu(null);
              onNewFavorite();
            }}
          >
            新規接続先
          </button>
          <button className="context-item" onClick={startCreateFolder}>
            フォルダを作成
          </button>
          {menu.target.kind !== "blank" && (
            <div className="color-row">
              {PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  className="color-swatch"
                  style={{ background: color }}
                  title={color}
                  onClick={() => applyColor(color)}
                />
              ))}
              <button
                className="color-swatch reset"
                title="既定色に戻す"
                onClick={() => applyColor(undefined)}
              >
                ×
              </button>
            </div>
          )}
          {menu.target.kind === "folder" && (
            <>
              <button
                className="context-item"
                onClick={() => {
                  const f = folders.find(
                    (x) => menu.target.kind === "folder" && x.id === menu.target.id
                  );
                  if (f) {
                    setRenamingId(f.id);
                    setRenameText(f.name);
                  }
                  setMenu(null);
                }}
              >
                名前を変更
              </button>
              <button
                className="context-item danger"
                onClick={() => {
                  if (menu.target.kind === "folder") {
                    onDeleteFolder(menu.target.id);
                  }
                  setMenu(null);
                }}
              >
                フォルダを削除
              </button>
            </>
          )}
          {menu.target.kind === "conn" && (
            <button
              className="context-item"
              onClick={() => {
                const c = connections.find(
                  (x) => menu.target.kind === "conn" && x.id === menu.target.id
                );
                if (c) onConnect(c);
                setMenu(null);
              }}
            >
              接続
            </button>
          )}
        </div>
      )}
    </div>
  );
}
