/**
 * 実行履歴とお気に入りの統合メニュー。
 *
 * 1つのボタンからドロップダウンを開き、タブで「履歴 / お気に入り」を切り替える。
 * どちらも項目を選ぶとエディタへ反映するだけ (実行はしない)。
 *
 * 中身は3つに分けてある:
 * 履歴の一覧 (HistoryList) / お気に入りのツリー (SavedTree) /
 * 保存とフォルダのダイアログ。ここは開閉と保存先とのやり取りを持つ
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePopupPosition } from "../../hooks/usePopupPosition";
import {
  clearSqlHistory,
  createSavedFolder,
  deleteSavedFolder,
  deleteSavedSql,
  deleteSqlHistory,
  getSavedSql,
  getSqlHistory,
  moveSavedNode,
  renameSavedFolder,
  upsertSavedSql,
} from "../../api";
import { SAVE_SQL_EVENT } from "../../appEvents";
import type {
  SavedSqlEntry,
  SavedSqlStore,
  SqlHistoryEntry,
} from "../../types";
import { isInside, resolveDrop, type DragRef, type DropSpot } from "../../savedTree";
import { ConfirmDialog } from "../ConfirmDialog";
import { useDismiss } from "../../hooks/useDismiss";
import { FolderDialog } from "./FolderDialog";
import { HistoryList } from "./HistoryList";
import { SaveSqlDialog } from "./SaveSqlDialog";
import { SavedTree } from "./SavedTree";

interface Props {
  /** 現在エディタにあるSQL (保存ダイアログの初期値) */
  currentSql: string;
  /** 履歴・お気に入りを選んだときにエディタへ反映する */
  onSelect: (sql: string) => void;
  /** 保存対象の呼び名 (SQL / コマンド等)。メニューの文言に使う */
  contentLabel?: string;
}

const EMPTY: SavedSqlStore = { folders: [], items: [], order: [] };

export function SqlLibraryMenu({
  currentSql,
  onSelect,
  contentLabel = "SQL",
}: Props) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0, flipY: 0 });
  // 画面の下や右で切れないよう位置を補正する
  const [menuRef, menuStyle] = usePopupPosition<HTMLDivElement>(
    menuPos.x,
    menuPos.y,
    menuPos.flipY
  );
  const btnRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"history" | "saved">("history");
  const [histEntries, setHistEntries] = useState<SqlHistoryEntry[]>([]);
  const [store, setStore] = useState<SavedSqlStore>(EMPTY);
  /** 開いているフォルダパス (既定は全て閉じた状態) */
  const [opened, setOpened] = useState<Set<string>>(new Set());
  /** 確認ダイアログ (項目の削除 / フォルダの削除 / 履歴の全消し) */
  const [confirm, setConfirm] = useState<
    | { kind: "item"; entry: SavedSqlEntry }
    | { kind: "folder"; path: string }
    | { kind: "history" }
    | null
  >(null);
  /** 保存/編集ダイアログ (editing = null なら新規保存) */
  const [saveDialog, setSaveDialog] = useState<
    { editing: SavedSqlEntry | null } | null
  >(null);
  /** フォルダのダイアログ (target = null なら新規作成) */
  const [folderDialog, setFolderDialog] = useState<{ target: string | null } | null>(
    null
  );
  /** 操作に失敗したときの文言 (メニューの上に出す) */
  const [error, setError] = useState<string | null>(null);

  const folderPaths = useMemo(() => store.folders, [store]);

  /**
   * ダイアログを出している間はメニューを隠す。
   * メニューは右クリックメニューと同じ重なり順 (モーダルより手前) なので、
   * 出したままだとダイアログに被ってしまう。
   * open は残しておくので、ダイアログを閉じると同じ場所に戻る
   */
  const dialogOpen = !!confirm || !!saveDialog || !!folderDialog;

  const reload = () => {
    getSqlHistory()
      .then(setHistEntries)
      .catch(() => setHistEntries([]));
    getSavedSql()
      .then(setStore)
      .catch(() => setStore(EMPTY));
  };

  // メニュー外クリックで閉じる。
  // 他のメニューを開いたときにも閉じるよう、キャプチャ段階で
  // 自分の領域外かどうかを判定する (stopPropagationの影響を受けない)。
  // 確認ダイアログを開いている間は、その操作で閉じない
  useDismiss(open, () => setOpen(false), {
    capture: true,
    ref: wrapRef,
    // ダイアログを開いている間は、その操作でメニューを閉じない
    skip: dialogOpen,
  });

  const toggleMenu = () => {
    if (!open) {
      reload();
      setConfirm(null);
      setError(null);
      // 開くたびにフォルダは全て閉じた状態から始める
      setOpened(new Set());
      // ボタン位置からfixed配置の座標を決める。
      // 親 (query-actions等) のoverflowにクリップされないようにするため
      const r = btnRef.current?.getBoundingClientRect();
      if (r) {
        const menuW = 460; // lib-menuのmin-width相当
        setMenuPos({
          x: Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8)),
          y: r.bottom + 5,
          // 下に入らないときはボタンの上へ出す
          flipY: r.top - 5,
        });
      }
    }
    setOpen((o) => !o);
  };

  const toggleFolder = (path: string) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /** 保存先を触る操作をまとめて包む (失敗はメニューに出す) */
  const apply = async (run: () => Promise<SavedSqlStore>) => {
    try {
      setStore(await run());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  /** ⌘S から保存ダイアログを開く (SQLエディタを開いている画面だけが反応する) */
  const openSaveDialog = useCallback((entry?: SavedSqlEntry) => {
    setSaveDialog({ editing: entry ?? null });
  }, []);
  useEffect(() => {
    const onSave = () => {
      if (!currentSql.trim()) return;
      // フォルダの選択肢を出すため、最新の内容を読んでから開く
      getSavedSql()
        .then(setStore)
        .catch(() => {});
      openSaveDialog();
    };
    window.addEventListener(SAVE_SQL_EVENT, onSave);
    return () => window.removeEventListener(SAVE_SQL_EVENT, onSave);
  }, [currentSql, openSaveDialog]);

  /** ドラッグで動かす */
  const handleMove = (drag: DragRef, spot: DropSpot) => {
    const r = resolveDrop(store, drag, spot);
    if (!r) return;
    void apply(() => moveSavedNode(r.node, r.parent, r.before));
  };

  /** 削除しようとしているフォルダの中身の数 (確認に出す) */
  const folderContents = (path: string) => {
    const folders = store.folders.filter(
      (f) => f !== path && isInside(f, path)
    ).length;
    const items = store.items.filter((e) => isInside(e.folder, path)).length;
    return { folders, items };
  };

  return (
    <div className="run-split saved-split" ref={wrapRef}>
      {/* メニューを開いている間はツールチップがメニューに被るため出さない */}
      <button
        ref={btnRef}
        className={"btn-secondary" + (open ? "" : " has-tooltip tooltip-left")}
        data-tooltip="実行履歴 (最新100件) とお気に入りを呼び出す"
        onClick={toggleMenu}
        onMouseDown={(e) => e.stopPropagation()}
      >
        履歴・お気に入り <span className="menu-caret">▾</span>
      </button>
      {open && !dialogOpen && (
        <div
          className="context-menu lib-menu"
          ref={menuRef}
          style={menuStyle}
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
              お気に入り
            </button>
          </div>
          <div className="context-sep" />
          {error && <div className="lib-error">{error}</div>}

          {mode === "history" ? (
            <HistoryList
              entries={histEntries}
              onPick={(sql) => {
                onSelect(sql);
                setOpen(false);
              }}
              onDelete={(sql) => {
                deleteSqlHistory(sql)
                  .then(setHistEntries)
                  .catch((e) => setError(String(e)));
              }}
              onClearAll={() => setConfirm({ kind: "history" })}
            />
          ) : (
            <>
              <button
                className="context-item saved-add"
                disabled={!currentSql.trim()}
                onClick={() => openSaveDialog()}
              >
                ＋ 現在の{contentLabel}を保存...
              </button>
              <button
                className="context-item saved-add"
                onClick={() => setFolderDialog({ target: null })}
              >
                ＋ 新しいフォルダ...
              </button>
              <div className="context-sep" />
              <SavedTree
                store={store}
                opened={opened}
                onToggleFolder={toggleFolder}
                onPickItem={(it) => {
                  onSelect(it.sql);
                  setOpen(false);
                }}
                onEditItem={(it) => openSaveDialog(it)}
                onDeleteItem={(entry) => setConfirm({ kind: "item", entry })}
                onRenameFolder={(path) => setFolderDialog({ target: path })}
                onDeleteFolder={(path) => setConfirm({ kind: "folder", path })}
                onMove={handleMove}
              />
            </>
          )}
        </div>
      )}

      {confirm?.kind === "item" && (
        <ConfirmDialog
          title="お気に入りを削除します"
          target={confirm.entry.name}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await apply(() => deleteSavedSql(confirm.entry.id));
            setConfirm(null);
          }}
        >
          このお気に入りを削除します。取り消しはできません。
        </ConfirmDialog>
      )}

      {confirm?.kind === "folder" && (
        <ConfirmDialog
          title="フォルダを中身ごと削除します"
          target={confirm.path}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await apply(() => deleteSavedFolder(confirm.path));
            setConfirm(null);
          }}
        >
          {(() => {
            const n = folderContents(confirm.path);
            return n.folders + n.items === 0
              ? "空のフォルダを削除します。"
              : `中のお気に入り${n.items}件` +
                  (n.folders > 0 ? ` とフォルダ${n.folders}個` : "") +
                  " も一緒に削除します。取り消しはできません。";
          })()}
        </ConfirmDialog>
      )}

      {confirm?.kind === "history" && (
        <ConfirmDialog
          title="実行履歴をすべて消します"
          target={`${histEntries.length}件`}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              setHistEntries(await clearSqlHistory());
            } catch (e) {
              setError(String(e));
            }
            setConfirm(null);
          }}
        >
          保存したお気に入りは消えません。取り消しはできません。
        </ConfirmDialog>
      )}

      {saveDialog && (
        <SaveSqlDialog
          editing={saveDialog.editing}
          folders={folderPaths}
          currentSql={currentSql}
          contentLabel={contentLabel}
          onClose={() => setSaveDialog(null)}
          onSubmit={async ({ name, folder, overwrite }) => {
            const editing = saveDialog.editing;
            // 新規: エディタのSQL / 編集: 上書き指定時だけ差し替える
            const sql = editing && !overwrite ? editing.sql : currentSql;
            setStore(await upsertSavedSql(editing?.id ?? null, name, folder, sql));
            setSaveDialog(null);
          }}
        />
      )}

      {folderDialog && (
        <FolderDialog
          target={folderDialog.target}
          folders={folderPaths}
          onClose={() => setFolderDialog(null)}
          onSubmit={async ({ name, parent }) => {
            if (folderDialog.target !== null) {
              setStore(await renameSavedFolder(folderDialog.target, name));
            } else {
              const path = parent ? `${parent}/${name}` : name;
              setStore(await createSavedFolder(path));
              // 作ったフォルダはすぐ見えるように開いておく
              setOpened((prev) => new Set(prev).add(parent).add(path));
            }
            setFolderDialog(null);
          }}
        />
      )}
    </div>
  );
}
