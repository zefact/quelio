/**
 * ER図のページ (タブ) バー。
 *
 * 1つの保存ファイルに複数の図を持てるので、その切り替えと並べ替え。
 * 図の中身とは関係のない操作なので、ErWindow から分けている
 */
import { useEffect, useRef, useState } from "react";
import { useEvent } from "../hooks/useEvent";

export interface ErPage {
  id: string;
  name: string;
}

export function ErPageTabs({
  pages,
  activeId,
  onSwitch,
  onAdd,
  onDelete,
  /** 並べ替え (ドラッグ中に何度も呼ばれる) */
  onReorder,
  /** 名前の変更 (空文字なら変えない) */
  onRename,
  /** 並べ替えのドラッグが終わったとき (保存の合図) */
  onReorderEnd,
}: {
  pages: ErPage[];
  activeId: string;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onRename: (id: string, name: string) => void;
  onReorderEnd: () => void;
}) {
  /** 名前を変更中のタブ */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  /** 並べ替えでつまんでいるタブの位置 (ドラッグ中だけ入る) */
  const dragIdx = useRef<number | null>(null);

  /** 名前の変更を確定する (空にはできない) */
  const commitRename = () => {
    if (editingId === null) return;
    const name = editText.trim();
    if (name) onRename(editingId, name);
    setEditingId(null);
  };

  /*
   * 並べ替えの終わり。
   * タブの外でボタンを離しても終われるよう、documentで受ける
   */
  const endReorder = useEvent(() => {
    if (dragIdx.current === null) return;
    dragIdx.current = null;
    onReorderEnd();
  });
  useEffect(() => {
    document.addEventListener("mouseup", endReorder);
    return () => document.removeEventListener("mouseup", endReorder);
  }, [endReorder]);

  return (
    <div className="er-tabs">
      {pages.map((p, i) => (
        <div
          key={p.id}
          className={"er-tab" + (p.id === activeId ? " active" : "")}
          title="クリックで切替 / ダブルクリックで名前変更 / ドラッグで並べ替え"
          onMouseDown={(e) => {
            if (e.button !== 0 || editingId === p.id) return;
            dragIdx.current = i;
            if (p.id !== activeId) onSwitch(p.id);
          }}
          onMouseEnter={() => {
            const from = dragIdx.current;
            if (from === null || from === i) return;
            onReorder(from, i);
            dragIdx.current = i;
          }}
          onDoubleClick={() => {
            setEditingId(p.id);
            setEditText(p.name);
          }}
        >
          {editingId === p.id ? (
            <input
              className="er-tab-input"
              value={editText}
              autoFocus
              onChange={(e) => setEditText(e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") setEditingId(null);
              }}
              onBlur={commitRename}
            />
          ) : (
            <>
              <span className="er-tab-name">{p.name}</span>
              {pages.length > 1 && (
                <span
                  className="er-tab-close"
                  title="タブを削除"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => onDelete(p.id)}
                >
                  ×
                </span>
              )}
            </>
          )}
        </div>
      ))}
      <button className="er-tab-add" title="タブを追加" onClick={onAdd}>
        ＋
      </button>
    </div>
  );
}
