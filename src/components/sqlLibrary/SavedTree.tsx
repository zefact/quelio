/**
 * お気に入りのフォルダツリー (表示とドラッグ操作)。
 *
 * ドラッグの落とし先は接続一覧と同じ考え方:
 * 行の上半分=前、下半分=後ろ、フォルダの中央=そのフォルダの中。
 * 「どこへ何番目で入るか」の計算は savedTree.ts に置いてあるので、
 * ここは「掴む・線を出す・落とす」だけを見る。
 *
 * draggable は行の <div> ではなく中の <button> に付ける。
 * WebView (WKWebView) では、ボタンなどの操作部品が親のドラッグ開始を
 * 飲み込んでしまい、掴めなくなるため (接続一覧と同じ作り)
 */
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SavedSqlEntry, SavedSqlStore } from "../../types";
import {
  buildTree,
  isInside,
  type DragRef,
  type DropSpot,
  type SavedNode,
} from "../../savedTree";

export interface SavedTreeProps {
  store: SavedSqlStore;
  /** 開いているフォルダのパス */
  opened: Set<string>;
  onToggleFolder: (path: string) => void;
  onPickItem: (entry: SavedSqlEntry) => void;
  onEditItem: (entry: SavedSqlEntry) => void;
  onDeleteItem: (entry: SavedSqlEntry) => void;
  onRenameFolder: (path: string) => void;
  onDeleteFolder: (path: string) => void;
  /** ドラッグで動かした (置けない場所では呼ばれない) */
  onMove: (drag: DragRef, spot: DropSpot) => void;
}

export function SavedTree({
  store,
  opened,
  onToggleFolder,
  onPickItem,
  onEditItem,
  onDeleteItem,
  onRenameFolder,
  onDeleteFolder,
  onMove,
}: SavedTreeProps) {
  /** 掴んでいるもの (描画には使わないので ref) */
  const drag = useRef<DragRef | null>(null);
  const [dragging, setDragging] = useState(false);
  const [spot, setSpot] = useState<DropSpot | null>(null);

  const startDrag = (e: React.DragEvent, item: DragRef) => {
    drag.current = item;
    setDragging(true);
    // WebKitではsetDataを呼ばないとドラッグが始まらない
    e.dataTransfer.setData("text/plain", "saved");
    e.dataTransfer.effectAllowed = "move";
  };

  const endDrag = () => {
    drag.current = null;
    setDragging(false);
    setSpot(null);
  };

  const over = (e: React.DragEvent, next: DropSpot) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = next.type === "denied" ? "none" : "move";
    setSpot((cur) =>
      JSON.stringify(cur) === JSON.stringify(next) ? cur : next
    );
  };

  const drop = (e: React.DragEvent, next: DropSpot) => {
    e.preventDefault();
    e.stopPropagation();
    const item = drag.current;
    endDrag();
    if (!item || next.type === "denied") return;
    onMove(item, next);
  };

  /** 項目の行: 上半分なら前、下半分なら後ろ */
  const itemSpot = (e: React.DragEvent, id: string): DropSpot => {
    const r = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    return { type: after ? "after" : "before", kind: "item", id };
  };

  /** フォルダの行: 上端/下端なら前後、中央ならその中へ */
  const folderSpot = (e: React.DragEvent, path: string): DropSpot => {
    const held = drag.current;
    // 自分自身と、その下へは入れられない
    if (held?.type === "folder" && isInside(path, held.path)) {
      return { type: "denied", key: path };
    }
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - r.top) / (r.height || 1);
    if (ratio < 0.28) return { type: "before", kind: "folder", path };
    if (ratio > 0.72) return { type: "after", kind: "folder", path };
    return { type: "into", path };
  };

  /** フォルダ行に出す印 */
  const folderMark = (path: string): string => {
    if (!spot) return "";
    if (spot.type === "into" && spot.path === path) return " drop-into";
    if (spot.type === "denied" && spot.key === path) return " drop-denied";
    if (
      (spot.type === "before" || spot.type === "after") &&
      spot.kind === "folder" &&
      spot.path === path
    ) {
      return spot.type === "before" ? " drop-before" : " drop-after";
    }
    return "";
  };

  /** 項目行に出す印 */
  const itemMark = (id: string): string => {
    if (!spot) return "";
    if (
      (spot.type === "before" || spot.type === "after") &&
      spot.kind === "item" &&
      spot.id === id
    ) {
      return spot.type === "before" ? " drop-before" : " drop-after";
    }
    return "";
  };

  const renderNode = (node: SavedNode, depth: number): ReactNode[] => {
    const out: ReactNode[] = [];
    for (const f of node.folders) {
      const closed = !opened.has(f.path);
      out.push(
        <div
          key={`f:${f.path}`}
          className={
            "saved-folder-row" + (dragging ? " dragging" : "") + folderMark(f.path)
          }
          onDragOver={(e) => over(e, folderSpot(e, f.path))}
          onDrop={(e) => drop(e, folderSpot(e, f.path))}
        >
          <button
            className="context-item saved-folder"
            style={{ paddingLeft: 12 + depth * 16 }}
            title="クリックで開閉 / ドラッグで移動"
            draggable
            onDragStart={(e) => startDrag(e, { type: "folder", path: f.path })}
            onDragEnd={endDrag}
            onClick={() => onToggleFolder(f.path)}
          >
            <span className="saved-caret" aria-hidden>
              {closed ? "▸" : "▾"}
            </span>
            {f.name}
          </button>
          <button
            className="saved-edit"
            title="フォルダ名を変える"
            onClick={() => onRenameFolder(f.path)}
          >
            ✎
          </button>
          <button
            className="saved-del"
            title="フォルダを中身ごと削除"
            onClick={() => onDeleteFolder(f.path)}
          >
            ×
          </button>
        </div>
      );
      if (!closed) out.push(...renderNode(f, depth + 1));
    }
    for (const it of node.items) {
      out.push(
        <div
          key={it.id}
          className={
            "saved-item-row" + (dragging ? " dragging" : "") + itemMark(it.id)
          }
          onDragOver={(e) => over(e, itemSpot(e, it.id))}
          onDrop={(e) => drop(e, itemSpot(e, it.id))}
        >
          <button
            className="context-item saved-item"
            style={{ paddingLeft: 12 + depth * 16 }}
            title={`${it.sql}\n\n(ドラッグで移動)`}
            draggable
            onDragStart={(e) => startDrag(e, { type: "item", id: it.id })}
            onDragEnd={endDrag}
            onClick={() => onPickItem(it)}
          >
            {it.name}
          </button>
          <button
            className="saved-edit"
            title="編集 (名前 / フォルダ / SQLの入れ替え)"
            onClick={() => onEditItem(it)}
          >
            ✎
          </button>
          <button className="saved-del" title="削除" onClick={() => onDeleteItem(it)}>
            ×
          </button>
        </div>
      );
    }
    return out;
  };

  const empty = store.folders.length === 0 && store.items.length === 0;

  return (
    <>
      {empty ? (
        <div className="history-empty">お気に入りはありません</div>
      ) : (
        renderNode(buildTree(store), 0)
      )}
      {/* 一番下の受け皿。ここへ落とすとフォルダの外 (ルート) へ出る */}
      <div
        className={
          "saved-root-drop" +
          (dragging ? " active" : "") +
          (spot?.type === "root-end" ? " drop-into" : "")
        }
        onDragOver={(e) => over(e, { type: "root-end" })}
        onDrop={(e) => drop(e, { type: "root-end" })}
      >
        {dragging && (
          <span className="root-drop-hint">
            ここへ落とすと、フォルダの外へ移動します
          </span>
        )}
      </div>
    </>
  );
}
