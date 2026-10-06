/**
 * 固定長のお気に入りの一覧に出す、フォルダの行。
 *
 * 行を押すと開閉する (SQLのお気に入りと同じ)。
 * 名前は右の ✎ から、その場で書き換える
 */
import type { KeyboardEvent, PointerEvent } from "react";
import { imeBusy } from "../../ime";
import { CloseMark } from "../CloseMark";
import { ChevronIcon, FolderIcon } from "../sqlLibrary/LibraryIcons";

interface Props {
  name: string;
  /** 中にいくつあるか */
  count: number;
  open: boolean;
  /** 行に足すクラス (放す場所の目印) */
  mark: string;
  /** 名前を書き換えている途中の文字 (書き換えていなければ null) */
  draft: string | null;
  onDraft: (text: string) => void;
  /** 書き換えた名前を決める */
  onCommit: () => void;
  /** 書き換えをやめる */
  onCancel: () => void;
  /** 名前の書き換えを始める */
  onRename: () => void;
  onToggle: () => void;
  /** フォルダを外す (中のお気に入りは残す) */
  onRemove: () => void;
  /** 行を押さえた (掴んで動かす用意) */
  onHold: (e: PointerEvent) => void;
}

export function CsvFavFolderRow({
  name,
  count,
  open,
  mark,
  draft,
  onDraft,
  onCommit,
  onCancel,
  onRename,
  onToggle,
  onRemove,
  onHold,
}: Props) {
  const editing = draft !== null;

  const onKey = (e: KeyboardEvent) => {
    // 日本語入力の変換を確定・取り消すキーは拾わない
    if (imeBusy(e)) return;
    // ここで止めないと、同じEscapeでメニューまで閉じてしまう
    if (e.key === "Enter" || e.key === "Escape") e.preventDefault();
    if (e.key === "Enter") onCommit();
    if (e.key === "Escape") onCancel();
  };

  return (
    <div
      className={"saved-folder-row csv-fav-row" + mark}
      data-row=""
      onPointerDown={onHold}
    >
      <div
        className="context-item saved-folder csv-fav-folder"
        role="button"
        aria-expanded={open}
        title="クリックで開閉 / ドラッグで移動"
        // 名前を書き換えている間は、欄を押しても開閉しない
        onClick={() => !editing && onToggle()}
      >
        <span className="saved-caret" aria-hidden>
          <ChevronIcon open={open} />
        </span>
        <FolderIcon open={open} />
        {editing ? (
          <input
            className="csv-fixed-folder-input"
            value={draft}
            autoFocus
            onChange={(e) => onDraft(e.target.value)}
            onBlur={onCommit}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={onKey}
          />
        ) : (
          <span className="saved-folder-name">{name}</span>
        )}
        {/* 閉じていても、中にいくつあるか分かるようにする */}
        <span className="saved-folder-count">{count}</span>
      </div>
      <button
        className="saved-edit"
        title="フォルダ名を変更"
        aria-label="フォルダ名を変更"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRename}
      >
        ✎
      </button>
      <button
        className="saved-del"
        title="フォルダを外す (中のお気に入りは残ります)"
        aria-label="フォルダを外す"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRemove}
      >
        <CloseMark size={10} />
      </button>
    </div>
  );
}
