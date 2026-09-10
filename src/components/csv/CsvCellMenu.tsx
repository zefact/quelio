/**
 * CSVの表を右クリックしたときのメニュー。
 *
 * 行と列で出す中身が違うだけなので、1ファイルに並べて置く。
 *
 * 何本か選んだ状態で右クリックしたときは、
 * 1本ぶんの項目に加えて「まとめて追加・削除」も出す
 */

interface RowProps {
  /** 右クリックした行 (0始まり) */
  row: number;
  /** 押した所と地続きで選ばれている行の先頭 */
  at: number;
  /** その本数 (1なら、まとめての項目は出さない) */
  count: number;
  onInsertAbove: (count: number) => void;
  onInsertBelow: (count: number) => void;
  onDelete: (at: number, count: number) => void;
}

/** 行を右クリックしたときのメニュー */
export function CsvRowMenu({
  row,
  at,
  count,
  onInsertAbove,
  onInsertBelow,
  onDelete,
}: RowProps) {
  const many = count > 1;
  return (
    <>
      <button className="context-item" onClick={() => onInsertAbove(1)}>
        上に1行追加
      </button>
      <button className="context-item" onClick={() => onInsertBelow(1)}>
        下に1行追加
      </button>
      {many && (
        <>
          <button className="context-item" onClick={() => onInsertAbove(count)}>
            上に{count}行追加
          </button>
          <button className="context-item" onClick={() => onInsertBelow(count)}>
            下に{count}行追加
          </button>
        </>
      )}
      <div className="context-sep" />
      <button className="context-item danger" onClick={() => onDelete(row, 1)}>
        {row + 1}行目を削除
      </button>
      {many && (
        <button
          className="context-item danger"
          onClick={() => onDelete(at, count)}
        >
          {at + 1}〜{at + count}行目を削除 ({count}行)
        </button>
      )}
    </>
  );
}

interface ColProps {
  name: string;
  /** 押した所と地続きで選ばれている列の先頭 */
  at: number;
  /** その本数 (1なら、まとめての項目は出さない) */
  count: number;
  /** 全部の列は消せないので、残る列があるか */
  canDelete: (count: number) => boolean;
  onInsertLeft: (count: number) => void;
  onInsertRight: (count: number) => void;
  onRename: () => void;
  onDelete: (at: number, count: number) => void;
}

/** 列の見出しを右クリックしたときのメニュー */
export function CsvColumnMenu({
  name,
  at,
  count,
  canDelete,
  onInsertLeft,
  onInsertRight,
  onRename,
  onDelete,
}: ColProps) {
  const many = count > 1;
  return (
    <>
      <button className="context-item" onClick={() => onInsertLeft(1)}>
        左に列を追加
      </button>
      <button className="context-item" onClick={() => onInsertRight(1)}>
        右に列を追加
      </button>
      {many && (
        <>
          <button className="context-item" onClick={() => onInsertLeft(count)}>
            左に{count}列追加
          </button>
          <button className="context-item" onClick={() => onInsertRight(count)}>
            右に{count}列追加
          </button>
        </>
      )}
      <div className="context-sep" />
      <button className="context-item" onClick={onRename}>
        列名を変更...
      </button>
      <DeleteItem
        label={`「${name}」を削除`}
        can={canDelete(1)}
        onClick={() => onDelete(at, 1)}
      />
      {many && (
        <DeleteItem
          label={`選んだ${count}列を削除`}
          can={canDelete(count)}
          onClick={() => onDelete(at, count)}
        />
      )}
    </>
  );
}

/** 列を消す項目 (消せないときは理由を出して押させない) */
function DeleteItem({
  label,
  can,
  onClick,
}: {
  label: string;
  can: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="context-item danger"
      disabled={!can}
      title={can ? undefined : "最後の1列は消せません"}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
