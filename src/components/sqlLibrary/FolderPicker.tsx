/**
 * 保存先フォルダの選択 (その場で新しく作ることもできる)。
 *
 * 以前はフォルダを作る口をメニュー側にだけ置いていたので、
 * 保存の途中で「入れたいフォルダが無い」と気づくと、ダイアログを閉じて
 * 作ってから開き直す必要があった。
 *
 * ここで作れるようにしたうえで、作るのは「＋ 新しいフォルダ」を押したときだけにする。
 * 選ぶ欄に直接打ち込ませないのは、打ち間違いで似た名前のフォルダが増えないようにするため
 */
import { SelectMenu } from "../SelectMenu";
import {
  folderExists,
  folderLabel,
  folderNameError,
  folderOptions,
  newFolderPath,
} from "../../savedSqlForm";

interface Props {
  /** 今あるフォルダ */
  folders: string[];
  /** 選んでいるフォルダ ("" = フォルダなし)。新しく作るときはその親になる */
  value: string;
  onChange: (path: string) => void;
  /** 新しく作るフォルダの名前 (null なら作らない) */
  creating: string | null;
  onCreatingChange: (name: string | null) => void;
}

export function FolderPicker({
  folders,
  value,
  onChange,
  creating,
  onCreatingChange,
}: Props) {
  if (creating === null) {
    return (
      <div className="folder-pick">
        <SelectMenu
          className="save-sql-input"
          popFixed
          value={value}
          options={folderOptions(folders)}
          onChange={onChange}
        />
        <button
          type="button"
          className="btn-ghost folder-pick-add"
          title="選んでいるフォルダの中に、新しいフォルダを作ります"
          onClick={() => onCreatingChange("")}
        >
          ＋ 新しいフォルダ
        </button>
      </div>
    );
  }

  const path = newFolderPath(value, creating);
  const error = folderNameError(creating);
  const typed = creating.trim() !== "";
  /** 作るのか、既にあるものへ入れるのか (どちらでも保存はできる) */
  const note = error
    ? error
    : !typed
      ? `${value ? `「${folderLabel(value)}」の中に` : "いちばん上に"}作ります`
      : folderExists(folders, path)
        ? `「${folderLabel(path)}」は既にあります。そこへ保存します`
        : `保存するときに「${folderLabel(path)}」を作ります`;

  return (
    <div className="folder-pick-box">
      <div className="folder-pick">
        {/* どこに作るのかを、入力欄の前に添える */}
        {value && (
          <span className="folder-pick-parent mono" title="この中に作ります">
            {folderLabel(value)} /
          </span>
        )}
        <input
          className="save-sql-input folder-pick-input"
          value={creating}
          autoFocus
          placeholder="新しいフォルダ名"
          onChange={(e) => onCreatingChange(e.target.value)}
        />
        <button
          type="button"
          className="btn-ghost folder-pick-add"
          onClick={() => onCreatingChange(null)}
        >
          やめる
        </button>
      </div>
      <span className={"save-sql-note" + (error ? " error" : "")}>{note}</span>
    </div>
  );
}
