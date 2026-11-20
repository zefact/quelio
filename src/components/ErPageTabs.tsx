/**
 * ER図のページの見出しの並び。
 *
 * 1つの保存ファイルに複数の図 (ページ) を持てるので、その切り替えと並べ替え。
 * 図の中身とは関係のない操作なので、ErWindow から分けている。
 *
 * ページの削除は元に戻せないので、見出しの × では消さず、
 * 右クリックのメニュー (「ページを削除…」) から確認してから消す
 */
import { useState } from "react";
import { TAB_MARK, useTabReorder } from "../hooks/useTabReorder";
import { useDismiss } from "../hooks/useDismiss";
import { usePopupPosition } from "../hooks/usePopupPosition";
import { imeBusy } from "../ime";

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
  /** 名前を変更中のページ */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  /** 右クリックのメニュー */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null
  );
  const [menuRef, menuStyle] = usePopupPosition<HTMLDivElement>(
    menu?.x ?? 0,
    menu?.y ?? 0
  );
  useDismiss(!!menu, () => setMenu(null), {
    capture: true,
    inside: ".er-page-menu",
    escape: true,
    resize: true,
  });
  /*
   * ドラッグで並べ替える。
   * 動かし終わったときだけ保存する (掴んだだけでは書かない)
   */
  const drag = useTabReorder({ onMove: onReorder, onEnd: onReorderEnd });

  /** 名前の変更を始める */
  const startRename = (p: ErPage) => {
    setEditingId(p.id);
    setEditText(p.name);
  };

  /** 名前の変更を確定する (空にはできない) */
  const commitRename = () => {
    if (editingId === null) return;
    const name = editText.trim();
    if (name) onRename(editingId, name);
    setEditingId(null);
  };

  return (
    <div className="er-tabs" data-find-skip>
      {pages.map((p, i) => (
        <div
          key={p.id}
          {...{ [TAB_MARK]: i }}
          className={
            "er-tab has-tooltip" +
            (p.id === activeId ? " active" : "") +
            (drag.dragging === i ? " dragging" : "")
          }
          style={drag.styleOf(i)}
          data-tooltip={`${p.name}\nダブルクリックで名前を変更 / ドラッグで並べ替え / 右クリックでメニュー`}
          onMouseDown={(e) => {
            // 名前を打っている最中は、掴ませない
            if (e.button !== 0 || editingId === p.id) return;
            drag.start(i, e);
            if (p.id !== activeId) onSwitch(p.id);
          }}
          onDoubleClick={() => startRename(p)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (p.id !== activeId) onSwitch(p.id);
            setMenu({ id: p.id, x: e.clientX, y: e.clientY });
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
                if (imeBusy(e)) return;
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") setEditingId(null);
              }}
              onBlur={commitRename}
            />
          ) : (
            <span className="er-tab-name">{p.name}</span>
          )}
        </div>
      ))}
      <button
        className="er-tab-add has-tooltip"
        data-tooltip="ページを追加"
        aria-label="ページを追加"
        onClick={onAdd}
      >
        ＋
      </button>

      {menu &&
        (() => {
          const p = pages.find((x) => x.id === menu.id);
          if (!p) return null;
          const last = pages.length <= 1;
          return (
            <div
              className="context-menu er-page-menu"
              ref={menuRef}
              style={menuStyle}
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button
                className="context-item"
                onClick={() => {
                  setMenu(null);
                  startRename(p);
                }}
              >
                ページの名前を変更
              </button>
              <button
                className="context-item"
                onClick={() => {
                  setMenu(null);
                  onAdd();
                }}
              >
                ページを追加
              </button>
              <div className="context-sep" aria-hidden />
              <button
                className="context-item danger has-tooltip"
                disabled={last}
                data-tooltip={last ? "最後の1ページは削除できません" : undefined}
                onClick={() => {
                  setMenu(null);
                  onDelete(p.id);
                }}
              >
                ページを削除…
              </button>
            </div>
          );
        })()}
    </div>
  );
}
