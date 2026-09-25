/**
 * フォルダの新規作成と名前の変更。
 *
 * 作る場所は選ばせない。新しいフォルダはいつも一覧のいちばん下
 * (どのフォルダにも入らない位置) にでき、動かすのはドラッグで行う。
 * 名前を変えるときも場所は動かさない。
 *
 * フォルダの削除はここ (名前を変える画面) からだけ行う。
 * 一覧の行に × を置くと、開閉しようとして押し間違えやすい
 */
import { useEffect, useRef, useState } from "react";
import { useModal } from "../../hooks/useModal";
import { folderNameError } from "../../savedSqlForm";
import { imeBusy } from "../../ime";

export function FolderDialog({
  /** 名前を変える対象のパス (新規作成なら null) */
  target,
  onClose,
  onSubmit,
  onDelete,
}: {
  target: string | null;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
  /** 中身ごと削除する (名前を変えるときだけ。確認は呼び出し側で出す) */
  onDelete?: () => void;
}) {
  const editing = target !== null;
  const [name, setName] = useState(
    editing ? target.slice(target.lastIndexOf("/") + 1) : ""
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Escで閉じる・枠へのフォーカスは共通の作法にそろえる
  const boxRef = useModal(onClose, !busy);
  const inputRef = useRef<HTMLInputElement>(null);
  // useModal が枠へフォーカスした後に、名前の欄へ移す (開いたときだけ)
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = name.trim();
  /** 「/」は階層の区切りなので名前には使えない */
  const nameError = folderNameError(name);

  const submit = async () => {
    if (!trimmed || nameError || busy) return;
    setError(null);
    setBusy(true);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal folder-modal"
        ref={boxRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">
            {editing ? "フォルダ名を変える" : "新しいフォルダ"}
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる">
            ×
          </button>
        </div>
        <div className="folder-body">
          <label className="save-sql-label">
            フォルダ名
            <input
              ref={inputRef}
              className="save-sql-input"
              value={name}
              placeholder="例: 月次集計"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                // 変換中のEnterは拾わない (確定の操作のため)
                if (imeBusy(e)) return;
                if (e.key === "Enter") void submit();
              }}
            />
            <span className={"save-sql-note" + (nameError ? " error" : "")}>
              {nameError ??
                (editing
                  ? "場所は変わりません (移動は一覧でドラッグ)"
                  : "一覧のいちばん下に作ります (移動は一覧でドラッグ)")}
            </span>
          </label>
          {error && <div className="save-sql-error">{error}</div>}
          <div className="save-sql-actions">
            {editing && onDelete && (
              <>
                <button
                  type="button"
                  className="btn-ghost danger"
                  disabled={busy}
                  onClick={onDelete}
                >
                  削除
                </button>
                <span className="toolbar-spacer" />
              </>
            )}
            <button className="btn-secondary" onClick={onClose}>
              キャンセル
            </button>
            <button
              className="btn-primary"
              disabled={!trimmed || !!nameError || busy}
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
