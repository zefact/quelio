/**
 * お気に入り (固定長の桁設定・列名の並び) のバックアップ (書き出すものを選ぶ)。
 *
 * 一覧と同じ並びにチェックボックスを付け、印を付けたものだけを書き出す。
 * フォルダに印を付けると中身が全部入り、外すと全部外れる。
 * 開いたときは全部に印が付いている (全部書き出すなら、そのまま押すだけ)。
 *
 * 固定長のファイルの形は設定画面のバックアップと同じなので、どちらの復元でも読める。
 * 呼び名・ファイル名・書き出す関数は種類ごとに `kind` で受け取る
 */
import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import type { FavNode } from "../../types";
import { useModal } from "../../hooks/useModal";
import { FolderIcon } from "../sqlLibrary/LibraryIcons";
import { TreeIndent } from "../sqlLibrary/TreeIndent";
import { TriCheckbox } from "../sqlLibrary/TriCheckbox";
import type { FavKind } from "./csvFavKinds";
import {
  backupFileName,
  exportPick,
  folderPick,
  pickAll,
  pickedCount,
  toggleFolderPick,
  togglePick,
} from "./csvLayoutPick";
import { flatLayouts } from "./csvLayoutTree";
import type { Named } from "./csvLayoutTree";

const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];

interface Props<T extends Named> {
  nodes: FavNode<T>[];
  /** お気に入りの種類 (呼び名・ファイル名・書き出す関数) */
  kind: FavKind<T>;
  onClose: () => void;
}

export function CsvLayoutBackupDialog<T extends Named>({ nodes, kind, onClose }: Props<T>) {
  const [sel, setSel] = useState<Set<string>>(() => pickAll(nodes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 書き出した数 (書き出したあとは結果だけを出す) */
  const [done, setDone] = useState<number | null>(null);
  const boxRef = useModal(onClose, !busy);

  const total = flatLayouts(nodes).length;
  const picked = pickedCount(sel);
  const plan = exportPick(sel);
  const nothing = plan.names.length === 0 && plan.folders.length === 0;

  const run = async () => {
    if (nothing || busy) return;
    const path = await save({
      defaultPath: backupFileName(kind.filePrefix, new Date()),
      filters: JSON_FILTER,
      title: `${kind.label}をバックアップ`,
    }).catch(() => null);
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await kind.exportSubset(path, plan.names, plan.folders));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** お気に入り1件の行 */
  const itemRow = (item: T, depth: number) => {
    const name = item.name;
    return (
    <label key={`i:${name}`} className="pick-row">
      <TreeIndent depth={depth} />
      <input
        type="checkbox"
        className="pick-check"
        checked={sel.has(`i:${name}`)}
        onChange={() => setSel((s) => togglePick(s, `i:${name}`))}
      />
      {kind.icon()}
      <span className="pick-name">{name}</span>
      <span className="er-pick-meta">
        {kind.sizeOf(item)}
        {kind.unit}
      </span>
    </label>
    );
  };

  return (
    <div className="modal-overlay" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal saved-transfer-modal"
        ref={boxRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">{kind.label}をバックアップ</span>
          <button className="modal-close" onClick={onClose} title="閉じる">
            ×
          </button>
        </div>

        {done !== null ? (
          <div className="saved-transfer-body">
            <p className="saved-transfer-done">
              {kind.label}を{done}件書き出しました。
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
                onClick={() => setSel(pickAll(nodes))}
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
            <div className="pick-list">
              {nodes.flatMap((n) =>
                n.kind === "folder"
                  ? [
                      <label key={`f:${n.name}`} className="pick-row pick-folder">
                        <TriCheckbox
                          state={folderPick(n, sel)}
                          onChange={() => setSel((s) => toggleFolderPick(n, s))}
                        />
                        <FolderIcon open />
                        <span className="pick-name">{n.name}</span>
                        <span className="saved-folder-count">
                          {n.items.length}
                        </span>
                      </label>,
                      ...n.items.map((s) => itemRow(s, 1)),
                    ]
                  : [itemRow(n, 0)]
              )}
            </div>
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
