/**
 * ER図の復元 (ファイルから選んで取り込む)。
 *
 * 今ある図は1つも書き換えない
 * (同じ名前の図を上書きする、設定画面の復元とはここが違う)。
 * 同じ名前の図があるときは「名前 (2)」のように番号を付けて足す。
 * 付ける名前は取り込む前に行ごとに見せる
 */
import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { ErFileEntry, ErImported } from "../types";
import { importErDiagramsAsNew, inspectErDiagramFile } from "../api";
import { useModal } from "../hooks/useModal";
import { entryMeta, toggleName } from "../er/erTransfer";
import { ErIcon } from "./ErIcon";

const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];

interface Props {
  onClose: () => void;
  /** 取り込んだあと (図の一覧を読み直して知らせる) */
  onDone: (done: ErImported[]) => void;
}

/** パスの末尾 (ファイル名) */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function ErRestoreDialog({ onClose, onDone }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<ErFileEntry[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useModal(onClose, !busy);

  /** ファイルを選んで、中の図を確かめる (最初は全部に印を付ける) */
  const pick = async () => {
    const chosen = await open({
      multiple: false,
      filters: JSON_FILTER,
      title: "ER図を復元",
    }).catch(() => null);
    if (typeof chosen !== "string") return;
    setError(null);
    setEntries(null);
    setPath(chosen);
    try {
      const list = await inspectErDiagramFile(chosen);
      setEntries(list);
      setSel(new Set(list.map((e) => e.name)));
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

  const picked = entries?.filter((e) => sel.has(e.name)) ?? [];
  const canRun = path !== null && picked.length > 0 && !busy;

  const run = async () => {
    if (!canRun || path === null) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await importErDiagramsAsNew(path, picked.map((e) => e.name)));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
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
          <span className="modal-title">ER図を復元</span>
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
          </div>

          {entries && entries.length === 0 && (
            <span className="save-sql-note">このファイルにはER図がありません</span>
          )}
          {entries && entries.length > 0 && (
            <>
              <div className="pick-head">
                <span className="pick-count">
                  {entries.length}件中 {picked.length}件を取り込みます
                </span>
                <span className="toolbar-spacer" />
                <button
                  type="button"
                  className="lib-action"
                  onClick={() => setSel(new Set(entries.map((e) => e.name)))}
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
                {entries.map((e) => (
                  <label key={e.name} className="pick-row">
                    <input
                      type="checkbox"
                      className="pick-check"
                      checked={sel.has(e.name)}
                      onChange={() => setSel((s) => toggleName(s, e.name))}
                    />
                    <span className="er-pick-icon">
                      <ErIcon />
                    </span>
                    <span className="er-pick-text">
                      <span className="pick-name">{e.name}</span>
                      {e.saveAs !== e.name && (
                        // 同じ名前の図があるので、番号を付けた名前で足す
                        <span className="er-pick-rename pick-name">
                          同じ名前があるので「{e.saveAs}」として追加
                        </span>
                      )}
                    </span>
                    <span className="er-pick-meta">{entryMeta(e)}</span>
                  </label>
                ))}
              </div>
            </>
          )}

          <p className="restore-safe">
            今あるER図は変わりません (同じ名前の図は上書きせず、番号を付けて足します)。
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
