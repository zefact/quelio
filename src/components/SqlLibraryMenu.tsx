import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  deleteSavedSql,
  getSavedSql,
  getSqlHistory,
  upsertSavedSql,
} from "../api";
import type { SavedSqlEntry, SqlHistoryEntry } from "../types";

interface Props {
  /** 現在エディタにあるSQL (保存ダイアログの初期値) */
  currentSql: string;
  /** 履歴・保存SQLを選んだときにエディタへ反映する */
  onSelect: (sql: string) => void;
}

/** 実行履歴メニューに表示する1行プレビュー */
function histPreview(sql: string): string {
  const line = sql.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/** 実行履歴の日時表示 (MM/DD HH:mm) */
function fmtHistTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** フォルダパスからツリーを組み立てるためのノード */
interface FolderNode {
  name: string;
  /** ルートからのパス ("集計/月次" 形式) */
  path: string;
  folders: FolderNode[];
  items: SavedSqlEntry[];
}

/** フラットな保存SQL一覧をフォルダツリーに変換する */
function buildTree(entries: SavedSqlEntry[]): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: [], items: [] };
  const getFolder = (path: string): FolderNode => {
    if (!path) return root;
    let node = root;
    let cur = "";
    for (const part of path.split("/")) {
      cur = cur ? `${cur}/${part}` : part;
      let child = node.folders.find((f) => f.path === cur);
      if (!child) {
        child = { name: part, path: cur, folders: [], items: [] };
        node.folders.push(child);
      }
      node = child;
    }
    return node;
  };
  for (const e of entries) {
    getFolder(e.folder).items.push(e);
  }
  const sortNode = (n: FolderNode) => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    n.items.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    n.folders.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

/**
 * 実行履歴と保存SQLの統合メニュー。
 * 1つのボタンからドロップダウンを開き、タブで「履歴 / 保存SQL」を切り替える。
 * どちらも項目を選ぶとエディタへ反映のみ行う (実行はしない)
 */
export function SqlLibraryMenu({ currentSql, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"history" | "saved">("history");
  // 履歴
  const [histEntries, setHistEntries] = useState<SqlHistoryEntry[]>([]);
  // 保存SQL
  const [entries, setEntries] = useState<SavedSqlEntry[]>([]);
  /** 折りたたみ中のフォルダパス */
  const [closed, setClosed] = useState<Set<string>>(new Set());
  /** 削除確認中の項目id (1回目のクリックで確認、2回目で削除) */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // 保存/編集ダイアログ (editing = null なら新規保存、そうでなければ編集)
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SavedSqlEntry | null>(null);
  const [saveName, setSaveName] = useState("");
  const [saveFolder, setSaveFolder] = useState("");
  /** 編集時: SQLを現在のエディタ内容で上書きするか */
  const [overwriteSql, setOverwriteSql] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(entries), [entries]);
  /** 既存フォルダパスの一覧 (保存ダイアログの入力補完用) */
  const folderPaths = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      if (!e.folder) continue;
      let cur = "";
      for (const part of e.folder.split("/")) {
        cur = cur ? `${cur}/${part}` : part;
        set.add(cur);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b, "ja"));
  }, [entries]);

  const reload = () => {
    getSqlHistory()
      .then(setHistEntries)
      .catch(() => setHistEntries([]));
    getSavedSql()
      .then(setEntries)
      .catch(() => setEntries([]));
  };

  // メニュー外クリックで閉じる (メニュー内はmousedownのstopPropagationで防ぐ)
  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setConfirmId(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const toggleMenu = () => {
    if (!open) {
      reload();
      setConfirmId(null);
    }
    setOpen((o) => !o);
  };

  const toggleFolder = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });

  /** 新規保存ダイアログを開く。entryを渡すと編集 (リネーム/フォルダ移動/上書き) */
  const openSaveDialog = (entry?: SavedSqlEntry) => {
    setEditing(entry ?? null);
    setSaveName(entry?.name ?? "");
    setSaveFolder(entry?.folder ?? "");
    setOverwriteSql(false);
    setSaveError(null);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    try {
      // 新規: エディタのSQLを保存 / 編集: 上書き指定時のみエディタのSQLに差し替え
      const sql = editing && !overwriteSql ? editing.sql : currentSql;
      const list = await upsertSavedSql(
        editing?.id ?? null,
        saveName,
        saveFolder,
        sql
      );
      setEntries(list);
      setDialogOpen(false);
    } catch (e) {
      setSaveError(String(e));
    }
  };

  const handleDelete = async (id: string) => {
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    setConfirmId(null);
    try {
      setEntries(await deleteSavedSql(id));
    } catch {
      reload();
    }
  };

  /** フォルダとその中身を再帰的に描画する */
  const renderFolder = (node: FolderNode, depth: number): ReactNode[] => {
    const out: ReactNode[] = [];
    for (const f of node.folders) {
      const isClosed = closed.has(f.path);
      out.push(
        <button
          key={`f:${f.path}`}
          className="context-item saved-folder"
          style={{ paddingLeft: 12 + depth * 16 }}
          onClick={() => toggleFolder(f.path)}
        >
          <span className="saved-caret" aria-hidden>
            {isClosed ? "▸" : "▾"}
          </span>
          {f.name}
        </button>
      );
      if (!isClosed) {
        out.push(...renderFolder(f, depth + 1));
      }
    }
    for (const it of node.items) {
      out.push(
        <div key={it.id} className="saved-item-row">
          <button
            className="context-item saved-item"
            style={{ paddingLeft: 12 + depth * 16 }}
            title={it.sql}
            onClick={() => {
              onSelect(it.sql);
              setOpen(false);
            }}
          >
            {it.name}
          </button>
          <button
            className="saved-edit"
            title="編集 (リネーム / フォルダ移動 / SQLの上書き)"
            onClick={() => {
              setOpen(false);
              openSaveDialog(it);
            }}
          >
            ✎
          </button>
          <button
            className={"saved-del" + (confirmId === it.id ? " confirm" : "")}
            title={confirmId === it.id ? "もう一度クリックで削除" : "削除"}
            onClick={() => handleDelete(it.id)}
          >
            {confirmId === it.id ? "削除?" : "×"}
          </button>
        </div>
      );
    }
    return out;
  };

  return (
    <div className="run-split saved-split">
      {/* メニューを開いている間はツールチップがメニューに被るため出さない */}
      <button
        className={
          "btn-secondary" + (open ? "" : " has-tooltip tooltip-left")
        }
        data-tooltip="実行履歴 (最新100件) と保存SQLを呼び出す"
        onClick={toggleMenu}
        onMouseDown={(e) => e.stopPropagation()}
      >
        履歴・保存 <span className="menu-caret">▾</span>
      </button>
      {open && (
        <div
          className="context-menu run-menu lib-menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="lib-tabs">
            <button
              className={mode === "history" ? "active" : ""}
              onClick={() => setMode("history")}
            >
              履歴
            </button>
            <button
              className={mode === "saved" ? "active" : ""}
              onClick={() => setMode("saved")}
            >
              保存SQL
            </button>
          </div>
          <div className="context-sep" />

          {mode === "history" ? (
            <>
              {histEntries.length === 0 && (
                <div className="history-empty">実行履歴はありません</div>
              )}
              {histEntries.map((h, i) => (
                <button
                  key={i}
                  className="context-item history-item"
                  title={h.sql}
                  onClick={() => {
                    onSelect(h.sql);
                    setOpen(false);
                  }}
                >
                  <span className="history-time">
                    {fmtHistTime(h.executedAtMs)}
                  </span>
                  <span className="history-sql mono">{histPreview(h.sql)}</span>
                </button>
              ))}
            </>
          ) : (
            <>
              <button
                className="context-item saved-add"
                disabled={!currentSql.trim()}
                onClick={() => {
                  setOpen(false);
                  openSaveDialog();
                }}
              >
                ＋ 現在のSQLを保存...
              </button>
              <div className="context-sep" />
              {entries.length === 0 ? (
                <div className="history-empty">保存されたSQLはありません</div>
              ) : (
                renderFolder(tree, 0)
              )}
            </>
          )}
        </div>
      )}

      {dialogOpen && (
        <div className="modal-overlay" onMouseDown={() => setDialogOpen(false)}>
          <div
            className="modal save-sql-modal"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDialogOpen(false);
            }}
          >
            <div className="modal-head">
              <span className="modal-title">
                {editing ? "保存SQLを編集" : "SQLを保存"}
              </span>
              <button
                className="modal-close"
                onClick={() => setDialogOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="save-sql-body">
              <label className="save-sql-label">
                名前
                <input
                  className="save-sql-input"
                  value={saveName}
                  autoFocus
                  placeholder="例: 受払一覧 (店舗別)"
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSave();
                  }}
                />
              </label>
              <label className="save-sql-label">
                フォルダ (任意・「/」で階層)
                <input
                  className="save-sql-input"
                  value={saveFolder}
                  list="saved-sql-folders"
                  placeholder="例: 集計/月次"
                  onChange={(e) => setSaveFolder(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSave();
                  }}
                />
                <datalist id="saved-sql-folders">
                  {folderPaths.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </label>
              {editing && (
                <label className="save-sql-overwrite">
                  <input
                    type="checkbox"
                    checked={overwriteSql}
                    disabled={!currentSql.trim()}
                    onChange={(e) => setOverwriteSql(e.target.checked)}
                  />
                  SQLを現在のエディタ内容で上書きする
                </label>
              )}
              <div className="save-sql-preview mono">
                {(editing && !overwriteSql ? editing.sql : currentSql)
                  .trim()
                  .slice(0, 300)}
              </div>
              {saveError && <div className="save-sql-error">{saveError}</div>}
              <div className="save-sql-actions">
                <button
                  className="btn-secondary"
                  onClick={() => setDialogOpen(false)}
                >
                  キャンセル
                </button>
                <button
                  className="btn-primary"
                  disabled={!saveName.trim()}
                  onClick={handleSave}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
