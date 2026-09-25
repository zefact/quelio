/**
 * お気に入りの復元 (ファイルから取り込む)。
 *
 * 取り込んだものは、新しく作るフォルダの中にだけ入れる。
 * 今あるお気に入りは1件も書き換えない
 * (同じIDのものを上書きする、設定画面の復元とはここが違う)。
 * 同じ名前のフォルダがあるときは「名前 (2)」のように番号を付けて作る
 */
import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { SavedSqlImported, SavedSqlSummary } from "../../types";
import { importSavedSqlInto, inspectSavedSqlFile } from "../../api";
import { useModal } from "../../hooks/useModal";
import { folderNameError } from "../../savedSqlForm";
import { restoreFolderName } from "../../savedSelection";

const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];

interface Props {
  onClose: () => void;
  /** 取り込んだあと (一覧を読み直し、作ったフォルダを開く) */
  onDone: (result: SavedSqlImported) => void;
}

/** パスの末尾 (ファイル名) */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function SavedRestoreDialog({ onClose, onDone }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [summary, setSummary] = useState<SavedSqlSummary | null>(null);
  const [name, setName] = useState(() => restoreFolderName(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useModal(onClose, !busy);

  /** ファイルを選んで、中身の数を確かめる */
  const pick = async () => {
    const chosen = await open({
      multiple: false,
      filters: JSON_FILTER,
      title: "お気に入りを復元",
    }).catch(() => null);
    if (typeof chosen !== "string") return;
    setError(null);
    setSummary(null);
    setPath(chosen);
    try {
      setSummary(await inspectSavedSqlFile(chosen));
    } catch (e) {
      setError(String(e));
    }
  };

  // 開いたらすぐファイルを選べるようにする (やめたらボタンから選び直せる)
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void pick();
  }, []);

  const nameError = folderNameError(name);
  const empty = summary !== null && summary.items + summary.folders === 0;
  const canRun =
    path !== null &&
    summary !== null &&
    !empty &&
    name.trim() !== "" &&
    !nameError &&
    !busy;

  const run = async () => {
    if (!canRun || path === null) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await importSavedSqlInto(path, name.trim()));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal saved-restore-modal"
        ref={boxRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">お気に入りを復元</span>
          <button className="modal-close" onClick={onClose} title="閉じる">
            ×
          </button>
        </div>

        <div className="saved-transfer-body">
          <div className="save-sql-label">
            ファイル
            <div className="restore-file">
              <span className="restore-file-name mono" title={path ?? ""}>
                {path ? baseName(path) : "(選んでいません)"}
              </span>
              <button
                type="button"
                className="btn-ghost folder-pick-add"
                disabled={busy}
                onClick={() => void pick()}
              >
                {path ? "選び直す…" : "ファイルを選ぶ…"}
              </button>
            </div>
            {summary && (
              <span className="save-sql-note">
                {empty
                  ? "このファイルにはお気に入りがありません"
                  : `お気に入り${summary.items}件` +
                    (summary.folders > 0 ? ` / フォルダ${summary.folders}個` : "")}
              </span>
            )}
          </div>

          <label className="save-sql-label">
            入れるフォルダ
            <input
              className="save-sql-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                // 変換中のEnterは拾わない (確定の操作のため)
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") void run();
              }}
            />
            <span className={"save-sql-note" + (nameError ? " error" : "")}>
              {nameError ??
                "このフォルダを一覧のいちばん下に新しく作り、その中に入れます。同じ名前があるときは番号を付けます"}
            </span>
          </label>

          <p className="restore-safe">
            今あるお気に入りは変わりません (上書きも削除もしません)。
          </p>

          {error && <div className="save-sql-error">{error}</div>}
          <div className="save-sql-actions">
            <button className="btn-secondary" onClick={onClose}>
              キャンセル
            </button>
            <button
              className="btn-primary"
              disabled={!canRun}
              onClick={() => void run()}
            >
              取り込む
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
