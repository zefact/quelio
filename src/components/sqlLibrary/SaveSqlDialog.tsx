/**
 * お気に入りの保存・編集ダイアログ。
 *
 * 名前・フォルダ・中身 (SQL) を1画面で直せるようにした。
 *
 * 以前は中身が先頭300文字しか見えず、直すには
 * 「エディタに読み込む → 直す → このダイアログで『上書き』に印を付ける」
 * と回り道が要った。何が保存されるのかも、印を付けるまで分からなかった。
 * いまは中身を全文ここで直せて、エディタの内容はボタン1つで取り込める。
 * 保存されるのは、いま欄に見えているものそのまま
 */
import { useEffect, useRef, useState } from "react";
import type { SavedSqlEntry } from "../../types";
import { MOD } from "../../keyLabel";
import {
  canImport,
  fmtUpdated,
  folderNameError,
  newFolderPath,
} from "../../savedSqlForm";
import { ModalFrame } from "../ModalFrame";
import { FolderPicker } from "./FolderPicker";
import { imeBusy } from "../../ime";

interface Props {
  /** 編集する項目 (新規保存なら null) */
  editing: SavedSqlEntry | null;
  /** 今あるフォルダのパス */
  folders: string[];
  /** 新規保存で最初に選んでおくフォルダ */
  defaultFolder?: string;
  /** 今エディタにあるSQL (新規保存の中身 / 取り込むときの中身) */
  currentSql: string;
  /** 保存するものの呼び名 (SQL / コマンド) */
  contentLabel: string;
  onClose: () => void;
  onSubmit: (v: { name: string; folder: string; sql: string }) => Promise<void>;
  /** 編集中の項目を消す (確認は呼び出し側で出す) */
  onDelete?: () => void;
}

export function SaveSqlDialog({
  editing,
  folders,
  defaultFolder = "",
  currentSql,
  contentLabel,
  onClose,
  onSubmit,
  onDelete,
}: Props) {
  const [name, setName] = useState(editing?.name ?? "");
  const [folder, setFolder] = useState(editing?.folder ?? defaultFolder);
  /** 新しく作るフォルダの名前 (null なら作らない) */
  const [creating, setCreating] = useState<string | null>(null);
  /** 保存する中身。編集なら保存済みの内容、新規ならエディタの内容から始める */
  const original = editing?.sql ?? currentSql;
  const [sql, setSql] = useState(original);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  // 枠 (ModalFrame) がフォーカスした後に、名前の欄へ移す (開いたときだけ)
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  /** 保存先 (新しく作るならそのパス) */
  const target = creating !== null ? newFolderPath(folder, creating) : folder;
  const folderError = creating !== null ? folderNameError(creating) : null;
  /** 「新しいフォルダ」を開いたまま名前が空 (どこへ入れるか決まっていない) */
  const folderPending = creating !== null && creating.trim() === "";
  /** 編集中に、中身を保存済みの内容から変えたか */
  const sqlChanged = editing !== null && sql !== editing.sql;
  /** 何か変えたか (変えたあとは、背景のクリックで閉じない) */
  const dirty =
    name !== (editing?.name ?? "") ||
    target !== (editing?.folder ?? defaultFolder) ||
    sql !== original;
  const canSave =
    name.trim() !== "" &&
    sql.trim() !== "" &&
    !folderError &&
    !folderPending &&
    !busy;

  /** 取り込めない理由 (ボタンのツールチップに出す) */
  const importTitle = !currentSql.trim()
    ? `エディタが空です`
    : currentSql === sql
      ? `エディタの内容と同じです`
      : `今エディタにある${contentLabel}で、下の欄を置き換えます`;

  const submit = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim(), folder: target, sql });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalFrame
      title={editing ? "お気に入りを編集" : `${contentLabel}をお気に入りに保存`}
      onClose={onClose}
      closable={!busy}
      // 何か変えたあとは、背景のクリックで閉じない (直した内容が消えるため)
      closeOnBackdrop={!dirty}
      className="save-sql-modal"
      footerNote={
        editing && (
          <span className="save-sql-foot-left">
            {onDelete && (
              <button
                type="button"
                className="btn-ghost danger"
                disabled={busy}
                onClick={onDelete}
              >
                削除…
              </button>
            )}
            {editing.updatedAtMs > 0 && (
              <span className="save-sql-updated">
                更新 {fmtUpdated(editing.updatedAtMs)}
              </span>
            )}
          </span>
        )
      }
      footer={
        <>
          <span className="save-sql-keyhint">{MOD}Enter で保存</span>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button
            className="btn-primary"
            disabled={!canSave}
            onClick={() => void submit()}
          >
            {editing ? "変更を保存する" : "保存する"}
          </button>
        </>
      }
    >
      <div className="save-sql-body">
        <label className="save-sql-label">
          名前
          <input
            ref={nameRef}
            className="save-sql-input"
            value={name}
            placeholder="例: 受払一覧 (店舗別)"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              // 変換中のEnterは拾わない (確定の操作のため)
              if (imeBusy(e)) return;
              if (e.key === "Enter") void submit();
            }}
          />
        </label>

        {/* SelectMenu は独自部品なので label では包まない */}
        <div className="save-sql-label">
          フォルダ
          <FolderPicker
            folders={folders}
            value={folder}
            onChange={setFolder}
            creating={creating}
            onCreatingChange={setCreating}
          />
        </div>

        <div className="save-sql-label">
          <div className="save-sql-field-head">
            <span>{contentLabel}</span>
            <button
              type="button"
              className="btn-ghost save-sql-import has-tooltip"
              disabled={!canImport(currentSql, sql)}
              data-tooltip={importTitle}
              onClick={() => setSql(currentSql)}
            >
              エディタの内容で置き換える
            </button>
          </div>
          <textarea
            className="save-sql-text mono"
            value={sql}
            spellCheck={false}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if (imeBusy(e)) return;
              // 欄の中のEnterは改行。保存は ⌘/Ctrl+Enter
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="save-sql-status">
            {editing === null ? (
              <span>
                今エディタにある{contentLabel}を入れています。ここで直してから保存できます
              </span>
            ) : sqlChanged ? (
              <>
                <span className="save-sql-changed">
                  保存済みの内容から変えています
                </span>
                <button
                  type="button"
                  className="save-sql-revert"
                  onClick={() => setSql(editing.sql)}
                >
                  元に戻す
                </button>
              </>
            ) : (
              <span>保存済みの内容です</span>
            )}
          </div>
        </div>

        {error && (
          <div className="result-banner ng">
            <span className="dot" aria-hidden />
            <span className="result-detail">{error}</span>
          </div>
        )}
      </div>
    </ModalFrame>
  );
}
