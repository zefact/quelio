/**
 * お気に入りへの保存・編集ダイアログ。
 *
 * フォルダは「作る」と「選ぶ」を分けた。
 * ここは選ぶだけ (作るのはメニューの「＋ 新しいフォルダ」) なので、
 * 打ち間違いで似た名前のフォルダが増えることがない
 */
import { useState } from "react";
import type { SavedSqlEntry } from "../../types";
import { SelectMenu } from "../SelectMenu";

export function SaveSqlDialog({
  /** 編集する項目 (新規保存なら null) */
  editing,
  /** 選べるフォルダのパス一覧 */
  folders,
  /** 今エディタにあるSQL (新規保存の中身 / 上書きの中身) */
  currentSql,
  contentLabel,
  onClose,
  onSubmit,
}: {
  editing: SavedSqlEntry | null;
  folders: string[];
  currentSql: string;
  contentLabel: string;
  onClose: () => void;
  onSubmit: (v: {
    name: string;
    folder: string;
    /** 編集時にSQLを今の内容へ入れ替えるか */
    overwrite: boolean;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [folder, setFolder] = useState(editing?.folder ?? "");
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await onSubmit({ name, folder, overwrite });
    } catch (e) {
      setError(String(e));
    }
  };

  /** 変換中のEnter/Escは拾わない (確定・取り消しの操作のため) */
  const keys = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") void submit();
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal save-sql-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="modal-head">
          <span className="modal-title">
            {editing ? "お気に入りを編集" : `${contentLabel}をお気に入りに保存`}
          </span>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="save-sql-body">
          <label className="save-sql-label">
            名前
            <input
              className="save-sql-input"
              value={name}
              autoFocus
              placeholder="例: 受払一覧 (店舗別)"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={keys}
            />
          </label>
          {/* SelectMenu は独自部品なので label では包まない */}
          <div className="save-sql-label">
            フォルダ
            <SelectMenu
              className="save-sql-input"
              popFixed
              value={folder}
              options={[
                { value: "", label: "(フォルダなし)" },
                ...folders.map((f) => ({ value: f, label: f })),
              ]}
              onChange={setFolder}
            />
            <span className="save-sql-note">
              フォルダはメニューの「＋ 新しいフォルダ」から作れます
            </span>
          </div>
          {editing && (
            <label className="save-sql-overwrite">
              <input
                type="checkbox"
                checked={overwrite}
                disabled={!currentSql.trim()}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              SQLを現在のエディタ内容で上書きする
            </label>
          )}
          <div className="save-sql-preview mono">
            {(editing && !overwrite ? editing.sql : currentSql)
              .trim()
              .slice(0, 300)}
          </div>
          {error && <div className="save-sql-error">{error}</div>}
          <div className="save-sql-actions">
            <button className="btn-secondary" onClick={onClose}>
              キャンセル
            </button>
            <button
              className="btn-primary"
              disabled={!name.trim()}
              onClick={() => void submit()}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
