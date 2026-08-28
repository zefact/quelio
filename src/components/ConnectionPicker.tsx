import { useMemo, useRef, useState } from "react";
import { badgeStyle, dbBadgeLabel, PRESET_COLORS } from "../colors";
import { usePopupPosition } from "../hooks/usePopupPosition";
import { useResizableWidth } from "../hooks/useResizableWidth";
import type {
  ConnectionProfile,
  ConnectionStore,
  FolderInfo,
  LayoutEntry,
  WorkTab,
} from "../types";
import { ConfirmDialog } from "./ConfirmDialog";
import { ConnectionForm } from "./ConnectionForm";
import { useDismiss } from "../hooks/useDismiss";

interface Props {
  tab: WorkTab;
  store: ConnectionStore;
  onCreateFolder: () => Promise<FolderInfo | null>;
  /** フォルダを削除する (確認はこのコンポーネントで出す。失敗したら例外を投げること) */
  onDeleteFolder: (id: string) => void | Promise<void>;
  onLayout: (
    folders: FolderInfo[],
    order: LayoutEntry[],
    rootOrder: string[]
  ) => void;
  /** 接続のアイコン色を変更 (undefinedで既定色に戻す) */
  onSetConnColor: (id: string, color: string | undefined) => void;
  onChangeProfile: (profile: ConnectionProfile) => void;
  onSelectFavorite: (profile: ConnectionProfile) => void;
  onNewFavorite: () => void;
  onSave: () => void;
  /** 接続先を削除する (確認はConnectionForm側で出す。失敗したら例外を投げること) */
  onDelete: () => void | Promise<void>;
  onTest: () => void;
  onConnect: (profile: ConnectionProfile) => void;
}

type DragItem = { type: "conn" | "folder"; id: string };
/** ドロップ先: 項目の前/後ろ、フォルダの中、一覧の末尾 */
type DropTarget =
  | { type: "before"; id: string }
  | { type: "after"; id: string }
  | { type: "into-folder"; id: string }
  /** 置けない場所 (フォルダをフォルダの中へ 等)。線は出さず、置けないことを示す */
  | { type: "denied"; id: string }
  | { type: "root-end" };

/** ルート階層に並ぶ項目 (フォルダ or フォルダ未所属の接続) */
type RootItem =
  | { kind: "folder"; folder: FolderInfo }
  | { kind: "conn"; conn: ConnectionProfile };

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
  // メニューが画面の外へはみ出さないように位置を補正する
  const [menuRef, menuStyle] = usePopupPosition<HTMLDivElement>(
    menu?.x ?? 0,
    menu?.y ?? 0
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const dragItem = useRef<DragItem | null>(null);
  /** ドラッグ中か (「一番下へ移動」エリアの案内を出すために使う) */
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const { folders, connections } = store;
  /** 削除の確認中のフォルダ (中の接続がどうなるかを見せてから消す) */
  const [deletingFolder, setDeletingFolder] = useState<FolderInfo | null>(null);

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

  /**
   * ルート階層の表示順 (フォルダと接続の混在)。
   * 保存された rootOrder を優先し、そこに無いものは
   * 従来どおり「フォルダ → 接続」の順で末尾に並べる
   */
  const rootItems = useMemo<RootItem[]>(() => {
    const items: RootItem[] = [];
    const used = new Set<string>();
    for (const id of store.rootOrder ?? []) {
      const f = folders.find((x) => x.id === id);
      if (f) {
        items.push({ kind: "folder", folder: f });
        used.add(id);
        continue;
      }
      const c = rootConnections.find((x) => x.id === id);
      if (c) {
        items.push({ kind: "conn", conn: c });
        used.add(id);
      }
    }
    for (const f of folders) {
      if (!used.has(f.id)) items.push({ kind: "folder", folder: f });
    }
    for (const c of rootConnections) {
      if (!used.has(c.id)) items.push({ kind: "conn", conn: c });
    }
    return items;
  }, [folders, rootConnections, store.rootOrder]);

  const rootItemId = (it: RootItem) =>
    it.kind === "folder" ? it.folder.id : it.conn.id;

  /** 指定IDが属するルート項目のID (フォルダ内の接続なら親フォルダ) */
  const rootAnchorOf = (id: string): string | null => {
    if (rootItems.some((it) => rootItemId(it) === id)) return id;
    const parent = folders.find((f) =>
      (childrenOf.get(f.id) ?? []).some((c) => c.id === id)
    );
    return parent?.id ?? null;
  };

  // メニューは画面のどこかをクリックしたら閉じる
  useDismiss(!!menu, () => setMenu(null));

  // ---------- 並び順の保存 ----------

  /** 現在の並びを (ルート項目ID, フォルダID→子接続ID) として取り出す */
  const snapshot = () => ({
    rootIds: rootItems.map(rootItemId),
    childIds: new Map(
      folders.map((f) => [
        f.id,
        (childrenOf.get(f.id) ?? []).map((c) => c.id),
      ])
    ),
  });

  /** 現在の表示順を LayoutEntry[] にする (保存・色変更などで使う) */
  const currentEntries = (): LayoutEntry[] => {
    const { rootIds, childIds } = snapshot();
    return buildEntries(rootIds, childIds);
  };

  /** ルート順とフォルダの子から、保存用の並び順を組み立てる */
  const buildEntries = (
    rootIds: string[],
    childIds: Map<string, string[]>
  ): LayoutEntry[] => {
    const entries: LayoutEntry[] = [];
    const done = new Set<string>();
    for (const id of rootIds) {
      const kids = childIds.get(id);
      if (kids) {
        // フォルダ: 直下の接続を続けて並べる
        for (const cid of kids) entries.push({ id: cid, folderId: id });
        done.add(id);
      } else {
        entries.push({ id, folderId: undefined });
      }
    }
    // ルート順に載っていないフォルダの中身も失わないようにする
    for (const [fid, kids] of childIds) {
      if (done.has(fid)) continue;
      for (const cid of kids) entries.push({ id: cid, folderId: fid });
    }
    return entries;
  };

  /** 並び替え結果を保存する (フォルダ配列もルート順に合わせる) */
  const applyOrder = (rootIds: string[], childIds: Map<string, string[]>) => {
    const rank = (id: string) => {
      const i = rootIds.indexOf(id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const nextFolders = [...folders].sort((a, b) => rank(a.id) - rank(b.id));
    onLayout(nextFolders, buildEntries(rootIds, childIds), rootIds);
  };

  /** 並びから対象IDを取り除く */
  const withoutItem = (
    rootIds: string[],
    childIds: Map<string, string[]>,
    id: string
  ) => ({
    rootIds: rootIds.filter((x) => x !== id),
    childIds: new Map(
      [...childIds].map(([k, v]) => [k, v.filter((x) => x !== id)])
    ),
  });

  /** ルート階層の指定位置へ移動する (targetIdがnullなら末尾) */
  const moveToRoot = (id: string, targetId: string | null, after: boolean) => {
    const snap = snapshot();
    const { rootIds, childIds } = withoutItem(snap.rootIds, snap.childIds, id);
    const idx = targetId === null ? -1 : rootIds.indexOf(targetId);
    if (idx < 0) rootIds.push(id);
    else rootIds.splice(after ? idx + 1 : idx, 0, id);
    applyOrder(rootIds, childIds);
  };

  /** 接続をフォルダの中 (末尾) へ移動する */
  const moveIntoFolder = (connId: string, folderId: string) => {
    const snap = snapshot();
    const { rootIds, childIds } = withoutItem(
      snap.rootIds,
      snap.childIds,
      connId
    );
    childIds.set(folderId, [...(childIds.get(folderId) ?? []), connId]);
    applyOrder(rootIds, childIds);
  };

  /** 接続を対象項目の前後へ移動する (対象がフォルダ内ならそのフォルダ内で並べ替え) */
  const moveConnNextTo = (connId: string, targetId: string, after: boolean) => {
    const parent = folders.find((f) =>
      (childrenOf.get(f.id) ?? []).some((c) => c.id === targetId)
    );
    if (!parent) {
      // 対象はルート項目 (フォルダ or ルート接続)
      moveToRoot(connId, targetId, after);
      return;
    }
    const snap = snapshot();
    const { rootIds, childIds } = withoutItem(
      snap.rootIds,
      snap.childIds,
      connId
    );
    const kids = [...(childIds.get(parent.id) ?? [])];
    const idx = kids.indexOf(targetId);
    kids.splice(idx < 0 ? kids.length : after ? idx + 1 : idx, 0, connId);
    childIds.set(parent.id, kids);
    applyOrder(rootIds, childIds);
  };

  /** フォルダの属性 (開閉・名前・色) を変えつつ、並び順は維持して保存する */
  const updateFolders = (next: FolderInfo[]) => {
    onLayout(next, currentEntries(), rootItems.map(rootItemId));
  };

  const toggleFolder = (id: string) => {
    updateFolders(
      folders.map((f) => (f.id === id ? { ...f, collapsed: !f.collapsed } : f))
    );
  };

  const commitRename = () => {
    if (renamingId) {
      const name = renameText.trim() || "(無名)";
      updateFolders(folders.map((f) => (f.id === renamingId ? { ...f, name } : f)));
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
      updateFolders(folders.map((f) => (f.id === id ? { ...f, color } : f)));
    } else if (menu.target.kind === "conn") {
      onSetConnColor(menu.target.id, color);
    }
    setMenu(null);
  };

  // ---------- D&D ----------

  /** WebKitではsetDataを呼ばないとドラッグが開始されない */
  const handleDragStart = (e: React.DragEvent, item: DragItem) => {
    dragItem.current = item;
    setDragging(true);
    e.dataTransfer.setData("text/plain", item.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragEnd = () => {
    dragItem.current = null;
    setDragging(false);
    setDropTarget(null);
  };

  const handleDrop = (e: React.DragEvent, target: DropTarget | null) => {
    e.preventDefault();
    e.stopPropagation();
    const item = dragItem.current;
    dragItem.current = null;
    setDragging(false);
    setDropTarget(null);
    // 置けない場所 (フォルダをフォルダの中へ 等) は何もしない
    if (!item || !target || target.type === "denied") return;
    // 自分自身の上に落とした場合は何もしない
    if ("id" in target && target.id === item.id) return;

    if (item.type === "conn") {
      if (target.type === "into-folder") {
        moveIntoFolder(item.id, target.id);
      } else if (target.type === "root-end") {
        moveToRoot(item.id, null, false);
      } else {
        moveConnNextTo(item.id, target.id, target.type === "after");
      }
      return;
    }
    // フォルダはルート階層でのみ移動する (フォルダの入れ子は作らない)
    if (target.type === "root-end") {
      moveToRoot(item.id, null, false);
    } else if (target.type !== "into-folder") {
      const anchor = rootAnchorOf(target.id);
      if (anchor && anchor !== item.id) {
        moveToRoot(item.id, anchor, target.type === "after");
      }
    }
  };

  const dragOver = (e: React.DragEvent, target: DropTarget | null) => {
    e.preventDefault();
    e.stopPropagation();
    // 置けない場所では「不可」のカーソルにする
    e.dataTransfer.dropEffect =
      target && target.type !== "denied" ? "move" : "none";
    setDropTarget((cur) =>
      JSON.stringify(cur) === JSON.stringify(target) ? cur : target
    );
  };

  /**
   * 接続項目上のドロップ位置: 上半分なら前へ、下半分なら後ろへ挿入。
   * フォルダをドラッグ中にフォルダ内の接続へ重ねたときは、
   * 入れ子は作れないので、そのフォルダ自体の前後を対象にする
   * (フォルダの中に入るような線を出さないため)
   */
  const connDropTarget = (e: React.DragEvent, id: string): DropTarget => {
    if (dragItem.current?.type === "folder") {
      const anchor = rootAnchorOf(id);
      // フォルダ内の接続に重ねている: 入れ子は作れないので置けない
      if (anchor && anchor !== id) return { type: "denied", id };
    }
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2
      ? { type: "after", id }
      : { type: "before", id };
  };

  /**
   * フォルダ行のドロップ位置。
   * 接続をドラッグ中は 上端/下端=フォルダの前後、中央=フォルダの中。
   * フォルダをドラッグ中は 上半分/下半分=前後 (入れ子にはしない)
   */
  const folderDropTarget = (e: React.DragEvent, id: string): DropTarget => {
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - r.top) / (r.height || 1);
    if (dragItem.current?.type === "folder") {
      return ratio > 0.5 ? { type: "after", id } : { type: "before", id };
    }
    if (ratio < 0.28) return { type: "before", id };
    if (ratio > 0.72) return { type: "after", id };
    return { type: "into-folder", id };
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
          (dropTarget?.type === "before" && dropTarget.id === c.id
            ? " drop-before"
            : "") +
          (dropTarget?.type === "after" && dropTarget.id === c.id
            ? " drop-after"
            : "") +
          (dropTarget?.type === "denied" && dropTarget.id === c.id
            ? " drop-denied"
            : "")
        }
        draggable
        onDragStart={(e) => handleDragStart(e, { type: "conn", id: c.id })}
        onDragEnd={handleDragEnd}
        onDragOver={(e) => dragOver(e, connDropTarget(e, c.id))}
        onDrop={(e) => handleDrop(e, connDropTarget(e, c.id))}
        onClick={() => onSelectFavorite(c)}
        onDoubleClick={() => onConnect(c)}
        onContextMenu={(e) => openMenu(e, { kind: "conn", id: c.id })}
        title="クリック: 選択 / ダブルクリック: 接続"
      >
        <span className={`db-badge ${c.dbType}`} style={badgeStyle(c.color)}>
          {dbBadgeLabel(c.dbType)}
        </span>
        <span className="connection-info">
          <span className="connection-name">{c.name || "(無名)"}</span>
          <span className="connection-host">
            {/* SQLiteはホスト:ポートを持たないのでファイルパスを出す */}
            {c.dbType === "sqlite" ? (
              (c.database ?? "(ファイル未設定)")
            ) : (
              <>
                {c.ssh?.enabled && <span className="ssh-chip">SSH</span>}
                {c.host}:{c.port}
              </>
            )}
          </span>
        </span>
      </button>
    </li>
  );

  const renderFolderItem = (f: FolderInfo) => {
    const children = childrenOf.get(f.id) ?? [];
    return (
      <li
        key={f.id}
        /* 前後の線はフォルダ全体 (見出し＋中の接続) の外側に出す。
           見出しの下に出すと「フォルダの中に入る」ように見えてしまうため */
        className={
          "folder-group" +
          (dropTarget?.type === "before" && dropTarget.id === f.id
            ? " drop-before"
            : "") +
          (dropTarget?.type === "after" && dropTarget.id === f.id
            ? " drop-after"
            : "")
        }
      >
        <button
          className={
            "folder-item" +
            (dropTarget?.type === "into-folder" && dropTarget.id === f.id
              ? " drop-into"
              : "")
          }
          draggable={renamingId !== f.id}
          onDragStart={(e) => handleDragStart(e, { type: "folder", id: f.id })}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => dragOver(e, folderDropTarget(e, f.id))}
          onDrop={(e) => handleDrop(e, folderDropTarget(e, f.id))}
          onClick={() => toggleFolder(f.id)}
          onContextMenu={(e) => openMenu(e, { kind: "folder", id: f.id })}
          title="クリック: 開閉 / ドラッグ: 並べ替え (中央へ落とすとフォルダに入ります)"
        >
          <span className={"chevron" + (f.collapsed ? "" : " open")} aria-hidden>
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
                // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
                if (e.nativeEvent.isComposing) return;
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
  };

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
          /* 項目の隙間に落ちたときの受け皿。どこに入るか示せないので線は出さない */
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(null);
          }}
          onDrop={(e) => handleDrop(e, { type: "root-end" })}
        >
          <ul className="connection-list">
            {rootItems.map((item) =>
              item.kind === "conn"
                ? renderConnItem(item.conn)
                : renderFolderItem(item.folder)
            )}
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
          {/* 一番下の受け皿。フォルダの外 (ルート階層の末尾) へ移動できる */}
          <div
            className={
              "root-drop-area" +
              (dragging ? " active" : "") +
              (dropTarget?.type === "root-end" ? " drop-into" : "")
            }
            onDragOver={(e) => dragOver(e, { type: "root-end" })}
            onDrop={(e) => handleDrop(e, { type: "root-end" })}
          >
            {dragging && (
              <span className="root-drop-hint">
                ここへドロップでフォルダの外 (一番下) へ移動
              </span>
            )}
          </div>
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
          ref={menuRef}
          style={menuStyle}
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
                    const id = menu.target.id;
                    setDeletingFolder(folders.find((f) => f.id === id) ?? null);
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

      {deletingFolder && (
        <ConfirmDialog
          title="フォルダを削除します"
          target={deletingFolder.name}
          onCancel={() => setDeletingFolder(null)}
          onConfirm={async () => {
            await onDeleteFolder(deletingFolder.id);
            setDeletingFolder(null);
          }}
        >
          {(() => {
            const n = connections.filter(
              (c) => c.folderId === deletingFolder.id
            ).length;
            return n > 0
              ? `中の接続 ${n} 件は削除されず、一覧の一番下 (フォルダの外) へ移動します。`
              : "このフォルダには接続がありません。";
          })()}
        </ConfirmDialog>
      )}
    </div>
  );
}
