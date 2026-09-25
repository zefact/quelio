/**
 * 絞り込み中のお気に入り一覧。
 *
 * 探しているときはフォルダの階層をたどらず、
 * 見つかったものを平らに並べる (どのフォルダのものかは行に添える)。
 * 並べ替えのドラッグもこの間は出さない
 */
import type { SavedSqlEntry } from "../../types";
import { SavedItemRow } from "./SavedItemRow";

interface Props {
  entries: SavedSqlEntry[];
  onPick: (entry: SavedSqlEntry) => void;
  onEdit: (entry: SavedSqlEntry) => void;
}

export function SavedSearchList({
  entries,
  onPick,
  onEdit,
}: Props) {
  if (entries.length === 0) {
    return <div className="history-empty">見つかりませんでした</div>;
  }
  return (
    <>
      {entries.map((it) => (
        <SavedItemRow
          key={it.id}
          entry={it}
          showFolder
          onPick={onPick}
          onEdit={onEdit}
        />
      ))}
    </>
  );
}
