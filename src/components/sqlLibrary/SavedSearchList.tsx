/**
 * 絞り込み中のお気に入り一覧。
 *
 * 探しているときはフォルダの階層をたどらず、
 * 見つかったものを平らに並べる (どのフォルダのものかは行に添える)。
 * 並べ替えのドラッグもこの間は出さない
 */
import type { SavedSqlEntry } from "../../types";

interface Props {
  entries: SavedSqlEntry[];
  onPick: (entry: SavedSqlEntry) => void;
  onEdit: (entry: SavedSqlEntry) => void;
  onDelete: (entry: SavedSqlEntry) => void;
}

export function SavedSearchList({ entries, onPick, onEdit, onDelete }: Props) {
  if (entries.length === 0) {
    return <div className="history-empty">見つかりませんでした</div>;
  }
  return (
    <>
      {entries.map((it) => (
        <div className="saved-item-row" key={it.id}>
          <button
            className="context-item saved-item saved-found"
            title={it.sql}
            onClick={() => onPick(it)}
          >
            <span className="saved-found-name">{it.name}</span>
            {/* どのフォルダのものかを添える (ルートのものは出さない) */}
            {it.folder && (
              <span className="saved-found-folder">{it.folder}</span>
            )}
          </button>
          <button
            className="saved-edit"
            title="編集 (名前 / フォルダ / SQLの入れ替え)"
            onClick={() => onEdit(it)}
          >
            ✎
          </button>
          <button
            className="saved-del"
            title="削除"
            onClick={() => onDelete(it)}
          >
            ×
          </button>
        </div>
      ))}
    </>
  );
}
