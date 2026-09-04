/**
 * CSVの表を右クリックしたときのメニュー。
 *
 * 行と列で出す中身が違うだけなので、1ファイルに並べて置く
 */

interface RowProps {
  /** 右クリックした行 (0始まり) */
  row: number;
  onInsertAbove: () => void;
  onInsertBelow: () => void;
  onDelete: () => void;
}

/** 行を右クリックしたときのメニュー */
export function CsvRowMenu({
  row,
  onInsertAbove,
  onInsertBelow,
  onDelete,
}: RowProps) {
  return (
    <>
      <button className="context-item" onClick={onInsertAbove}>
        上に1行追加
      </button>
      <button className="context-item" onClick={onInsertBelow}>
        下に1行追加
      </button>
      <div className="context-sep" />
      <button className="context-item danger" onClick={onDelete}>
        {row + 1}行目を削除
      </button>
    </>
  );
}

interface ColProps {
  name: string;
  /** 最後の1列は消せない */
  canDelete: boolean;
  onInsertLeft: () => void;
  onInsertRight: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/** 列の見出しを右クリックしたときのメニュー */
export function CsvColumnMenu({
  name,
  canDelete,
  onInsertLeft,
  onInsertRight,
  onRename,
  onDelete,
}: ColProps) {
  return (
    <>
      <button className="context-item" onClick={onInsertLeft}>
        左に列を追加
      </button>
      <button className="context-item" onClick={onInsertRight}>
        右に列を追加
      </button>
      <div className="context-sep" />
      <button className="context-item" onClick={onRename}>
        列名を変更...
      </button>
      <button
        className="context-item danger"
        disabled={!canDelete}
        title={canDelete ? undefined : "最後の1列は消せません"}
        onClick={onDelete}
      >
        「{name}」を削除
      </button>
    </>
  );
}
