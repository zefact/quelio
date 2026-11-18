/**
 * 列名のお気に入りの一覧に出す、お気に入り1件の行。
 *
 * 行を押すと、その列名を今のファイルに付ける。
 * 行を押さえて動かすと並べ替えられる (固定長のお気に入りと同じ)
 */
import type { PointerEvent } from "react";
import type { CsvNameSet } from "../../types";
import { CloseMark } from "../CloseMark";
import { TreeIndent } from "../sqlLibrary/TreeIndent";
import { NameSetIcon } from "./CsvLayoutIcons";
import { namePreview } from "./csvNameSets";

interface Props {
  saved: CsvNameSet;
  /** フォルダの中にあるか (あれば縦線つきで1段下げる) */
  inFolder: boolean;
  /** 今このファイルに付いているか */
  applied: boolean;
  /** 今のファイルに付けられないときの理由 (付けられれば null) */
  blocked: string | null;
  /** 行に足すクラス (放す場所の目印) */
  mark: string;
  onUse: () => void;
  onDelete: () => void;
  /** 行を押さえた (掴んで動かす用意) */
  onHold: (e: PointerEvent) => void;
}

export function CsvNameItemRow({
  saved,
  inFolder,
  applied,
  blocked,
  mark,
  onUse,
  onDelete,
  onHold,
}: Props) {
  const list = saved.columns
    .map((c, i) => `${i + 1}: ${c || "(名前なし)"}`)
    .join("\n");
  return (
    <div
      className={"saved-item-row csv-fav-row" + mark}
      data-row=""
      onPointerDown={onHold}
    >
      <button
        className={
          "context-item saved-item" + (applied ? " csv-fav-applied" : "")
        }
        // 付けられないときも並べ替えはできるよう、押せなくはせず理由を出す
        aria-disabled={!!blocked}
        title={
          (applied ? "このファイルに付いています\n" : "") +
          (blocked ?? "クリックでこの列名を今のファイルに付ける") +
          " / ドラッグで移動\n" +
          list
        }
        onClick={() => {
          if (!blocked) onUse();
        }}
      >
        {inFolder && <TreeIndent depth={1} />}
        {/* フォルダの開閉の印の位置をあけ、アイコンの列をそろえる */}
        <span className="saved-caret" aria-hidden />
        <NameSetIcon />
        <span className="saved-item-name">{saved.name}</span>
        {applied && <span className="csv-fav-using">使用中</span>}
        <span className="saved-item-folder csv-names-preview">
          {namePreview(saved.columns)}
        </span>
      </button>
      <button
        className="saved-del"
        title="このお気に入りを削除"
        aria-label="このお気に入りを削除"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onDelete}
      >
        <CloseMark size={10} />
      </button>
    </div>
  );
}
