/**
 * お気に入り1件の行 (ツリーと検索結果で共通)。
 *
 * 名前の前にSQLのアイコンを付け、フォルダと見分けやすくする。
 * 中身は行には出さず、乗せたときのツールチップで見せる
 * (一覧に並べると、行が長くなって階層が追いにくくなる)。
 *
 * 行に置く操作は編集 (✎) だけにして、常に薄く出しておく。
 * 削除は編集画面の中から行う (一覧の × は、読み込もうとして押し間違えやすい)
 */
import type { DragEvent } from "react";
import type { SavedSqlEntry } from "../../types";
import { folderLabel } from "../../savedSqlForm";
import { SqlIcon } from "./LibraryIcons";
import { TreeIndent } from "./TreeIndent";

/** ドラッグで並べ替えるときに行へ付ける操作 (ツリーのときだけ) */
export interface RowDrag {
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

/** ツールチップに出す中身の長さ (長すぎると画面からはみ出す) */
const TIP_LEN = 600;

interface Props {
  entry: SavedSqlEntry;
  /**
   * ツリーの深さ (ツリーのときだけ)。
   * 渡すと階層の縦線と、フォルダの開閉の印ぶんの余白を付ける
   */
  depth?: number;
  /** 行に足すクラス (ドラッグの差し込み線など) */
  rowClass?: string;
  /** どのフォルダのものかを添える (検索結果のとき) */
  showFolder?: boolean;
  drag?: RowDrag;
  onPick: (entry: SavedSqlEntry) => void;
  onEdit: (entry: SavedSqlEntry) => void;
}

export function SavedItemRow({
  entry,
  depth,
  rowClass = "",
  showFolder = false,
  drag,
  onPick,
  onEdit,
}: Props) {
  const sql =
    entry.sql.length > TIP_LEN ? `${entry.sql.slice(0, TIP_LEN)}…` : entry.sql;
  const how = drag
    ? "クリックでエディタに読み込む / ドラッグで移動"
    : "クリックでエディタに読み込む";
  return (
    <div
      className={"saved-item-row" + rowClass}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
    >
      {/*
       * draggable は行ではなくボタンに付ける。
       * WebView (WKWebView) では、中の操作部品が親のドラッグ開始を飲み込むため
       */}
      <button
        className="context-item saved-item"
        title={`${sql}\n\n${how}`}
        draggable={!!drag}
        onDragStart={drag?.onDragStart}
        onDragEnd={drag?.onDragEnd}
        onClick={() => onPick(entry)}
      >
        {depth !== undefined && (
          <>
            <TreeIndent depth={depth} />
            {/* フォルダの開閉の印の位置をあけ、アイコンの列をそろえる */}
            <span className="saved-caret" aria-hidden />
          </>
        )}
        <SqlIcon />
        <span className="saved-item-name">{entry.name}</span>
        {showFolder && entry.folder && (
          <span className="saved-item-folder">{folderLabel(entry.folder)}</span>
        )}
      </button>
      <button
        className="saved-edit"
        title="編集 (名前・フォルダ・中身。削除もここから)"
        aria-label="編集"
        onClick={() => onEdit(entry)}
      >
        ✎
      </button>
    </div>
  );
}
