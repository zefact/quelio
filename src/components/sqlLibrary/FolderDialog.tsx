/**
 * フォルダの新規作成と名前の変更。
 *
 * 作るときは「どこに作るか」も選ぶ。
 * 名前を変えるときは場所は動かさない (移動はドラッグで行う)
 */
import { useState } from "react";
import { SelectMenu } from "../SelectMenu";

export function FolderDialog({
  /** 名前を変える対象のパス (新規作成なら null) */
  target,
  /** 選べる親フォルダのパス一覧 (新規作成のときだけ使う) */
  folders,
  /** 新規作成時に最初に選んでおく親 */
  defaultParent = "",
  onClose,
  onSubmit,
}: {
  target: string | null;
  folders: string[];
  defaultParent?: string;
  onClose: () => void;
  onSubmit: (v: { name: string; parent: string }) => Promise<void>;
}) {
  const editing = target !== null;
  const [name, setName] = useState(
    editing ? target.slice(target.lastIndexOf("/") + 1) : ""
  );
  const [parent, setParent] = useState(defaultParent);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  /** 作成後 / 変更後のフルパス (下に小さく出す) */
  const preview = editing
    ? (target.includes("/")
        ? target.slice(0, target.lastIndexOf("/") + 1)
        : "") + (trimmed || "…")
    : (parent ? `${parent}/` : "") + (trimmed || "…");

  const submit = async () => {
    if (!trimmed || busy) return;
    setError(null);
    setBusy(true);
    try {
      await onSubmit({ name: trimmed, parent });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal folder-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="modal-head">
          <span className="modal-title">
            {editing ? "フォルダ名を変える" : "新しいフォルダ"}
          </span>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="folder-body">
          <label className="save-sql-label">
            フォルダ名
            <input
              className="save-sql-input"
              value={name}
              autoFocus
              placeholder="例: 月次集計"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                // 変換中のEnterは拾わない (確定の操作のため)
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") void submit();
              }}
            />
          </label>
          {!editing && (
            // SelectMenu は独自部品なので label では包まない
            <div className="save-sql-label">
              作る場所
              <SelectMenu
                className="save-sql-input"
                popFixed
                value={parent}
                options={[
                  { value: "", label: "(いちばん上)" },
                  ...folders.map((f) => ({ value: f, label: f })),
                ]}
                onChange={setParent}
              />
            </div>
          )}
          <div className="folder-preview">
            <span className="folder-preview-label">できあがり</span>
            <span className="folder-preview-path mono">{preview}</span>
          </div>
          {error && <div className="save-sql-error">{error}</div>}
          <div className="save-sql-actions">
            <button className="btn-secondary" onClick={onClose}>
              キャンセル
            </button>
            <button
              className="btn-primary"
              disabled={!trimmed || busy}
              onClick={() => void submit()}
            >
              {editing ? "変更" : "作成"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
