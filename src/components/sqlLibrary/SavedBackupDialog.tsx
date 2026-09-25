/**
 * お気に入りのバックアップ (書き出すものを選ぶ)。
 *
 * 一覧と同じツリーにチェックボックスを付け、印を付けたものだけを書き出す。
 * フォルダに印を付けると中身が全部入り、外すと全部外れる。
 * 開いたときは全部に印が付いている (全部書き出すなら、そのまま押すだけ)。
 *
 * ファイルの形は設定画面のバックアップと同じなので、どちらの復元でも読める
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import type { SavedSqlStore } from "../../types";
import { exportSavedSqlSubset } from "../../api";
import { useModal } from "../../hooks/useModal";
import { buildTree, itemsInside, type SavedNode } from "../../savedTree";
import {
  backupFileName,
  exportPlan,
  folderCheck,
  selectAll,
  selectedItemCount,
  toggleFolder,
  toggleItem,
} from "../../savedSelection";
import { FolderIcon, SqlIcon } from "./LibraryIcons";
import { TreeIndent } from "./TreeIndent";
import { TriCheckbox } from "./TriCheckbox";

const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];

interface Props {
  store: SavedSqlStore;
  onClose: () => void;
}

export function SavedBackupDialog({ store, onClose }: Props) {
  const [sel, setSel] = useState<Set<string>>(() => selectAll(store));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 書き出した数 (書き出したあとは結果だけを出す) */
  const [done, setDone] = useState<number | null>(null);
  const boxRef = useModal(onClose, !busy);

  const tree = useMemo(() => buildTree(store), [store]);
  const total = store.items.length;
  const picked = selectedItemCount(sel);
  const plan = exportPlan(sel);
  const nothing = plan.ids.length === 0 && plan.folders.length === 0;

  const run = async () => {
    if (nothing || busy) return;
    const path = await save({
      defaultPath: backupFileName(new Date()),
      filters: JSON_FILTER,
      title: "お気に入りをバックアップ",
    }).catch(() => null);
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await exportSavedSqlSubset(path, plan.ids, plan.folders));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 保存されている表示順のまま、印を付けられる行を並べる (フォルダは開いたまま) */
  const rows = (node: SavedNode, depth: number): ReactNode[] =>
    node.children.flatMap((child): ReactNode[] => {
      if (child.kind === "folder") {
        const f = child.node;
        return [
          <label key={`f:${f.path}`} className="pick-row pick-folder">
            <TreeIndent depth={depth} />
            <TriCheckbox
              state={folderCheck(store, sel, f.path)}
              onChange={() => setSel((s) => toggleFolder(store, s, f.path))}
            />
            <FolderIcon open />
            <span className="pick-name">{f.name}</span>
            <span className="saved-folder-count">
              {itemsInside(store, f.path)}
            </span>
          </label>,
          ...rows(f, depth + 1),
        ];
      }
      const it = child.entry;
      return [
        <label key={`i:${it.id}`} className="pick-row" title={it.sql}>
          <TreeIndent depth={depth} />
          <input
            type="checkbox"
            className="pick-check"
            checked={sel.has(`i:${it.id}`)}
            onChange={() => setSel((s) => toggleItem(s, it.id))}
          />
          <SqlIcon />
          <span className="pick-name">{it.name}</span>
        </label>,
      ];
    });

  return (
    <div className="modal-overlay" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal saved-transfer-modal"
        ref={boxRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">お気に入りをバックアップ</span>
          <button className="modal-close" onClick={onClose} title="閉じる">
            ×
          </button>
        </div>

        {done !== null ? (
          <div className="saved-transfer-body">
            <p className="saved-transfer-done">
              お気に入りを{done}件書き出しました。
            </p>
            <div className="save-sql-actions">
              <button className="btn-primary" onClick={onClose}>
                閉じる
              </button>
            </div>
          </div>
        ) : (
          <div className="saved-transfer-body">
            <div className="pick-head">
              <span className="pick-count">
                {total}件中 {picked}件を書き出します
              </span>
              <span className="toolbar-spacer" />
              <button
                type="button"
                className="lib-action"
                onClick={() => setSel(selectAll(store))}
              >
                すべて選ぶ
              </button>
              <button
                type="button"
                className="lib-action"
                onClick={() => setSel(new Set())}
              >
                すべて外す
              </button>
            </div>
            <div className="pick-list">{rows(tree, 0)}</div>
            <span className="save-sql-note">
              フォルダに印を付けると中身が全部入ります。書き出したファイルは「復元」で読み込めます
            </span>
            {error && <div className="save-sql-error">{error}</div>}
            <div className="save-sql-actions">
              <button className="btn-secondary" onClick={onClose}>
                キャンセル
              </button>
              <button
                className="btn-primary"
                disabled={nothing || busy}
                onClick={() => void run()}
              >
                書き出す…
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
