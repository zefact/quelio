/**
 * 固定長のお気に入りの一覧に出す、お気に入り1件の行。
 *
 * 行を押すと、その桁設定で読み直す。
 * 名前や桁を直すときは右の ✎ から (SQLのお気に入りと同じ)
 */
import type { PointerEvent } from "react";
import type { CsvSavedLayout } from "../../types";
import { CloseMark } from "../CloseMark";
import { TreeIndent } from "../sqlLibrary/TreeIndent";
import { LayoutIcon } from "./CsvLayoutIcons";
import { UNIT_LABEL, totalWidth } from "./csvFixed";

interface Props {
  saved: CsvSavedLayout;
  /** フォルダの中にあるか (あれば縦線つきで1段下げる) */
  inFolder: boolean;
  /** 今このファイルに使われているか */
  applied: boolean;
  /**
   * 行を押したら読み直せるか。
   *
   * 読み直す相手が無いとき (ファイルを開いていない) は、
   * 行を押すと名前・桁設定を直す画面が開く (呼び出し側で切り替える)
   */
  canApply: boolean;
  /** 行を押した */
  /** 行に足すクラス (放す場所の目印) */
  mark: string;
  onUse: () => void;
  /** 名前・桁設定を直す画面を開く */
  onEdit: () => void;
  onDelete: () => void;
  /** 行を押さえた (掴んで動かす用意) */
  onHold: (e: PointerEvent) => void;
}

export function CsvFavItemRow({
  saved,
  inFolder,
  applied,
  canApply,
  mark,
  onUse,
  onEdit,
  onDelete,
  onHold,
}: Props) {
  const { columns, unit } = saved.layout;
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
        title={
          (applied ? "このファイルに使われています\n" : "") +
          `${columns.length}桁 (計${totalWidth(columns)}${UNIT_LABEL[unit]})\n` +
          (canApply
            ? "クリックでこの桁設定で読み直す"
            : "クリックで名前・桁設定を変更") +
          " / ドラッグで移動"
        }
        onClick={onUse}
      >
        {inFolder && <TreeIndent depth={1} />}
        {/* フォルダの開閉の印の位置をあけ、アイコンの列をそろえる */}
        <span className="saved-caret" aria-hidden />
        <LayoutIcon />
        <span className="saved-item-name">{saved.name}</span>
        {applied && <span className="csv-fav-using">使用中</span>}
        <span className="saved-item-folder mono">{columns.length}桁</span>
      </button>
      <button
        className="saved-edit"
        title="名前・桁設定を変更"
        aria-label="名前・桁設定を変更"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onEdit}
      >
        ✎
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
