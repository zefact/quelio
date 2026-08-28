interface Props {
  table: string;
  /** 幅を手で変えてあるか (「自動に戻す」を出すかの判断) */
  hasWidth: boolean;
  /** まとめて削除する対象 (1件ならこのテーブルだけ) */
  selectedCount: number;
  onResetWidth: () => void;
  onDelete: () => void;
}

/** テーブルの見出しを右クリックしたときのメニュー */
export function NodeMenu({
  hasWidth,
  selectedCount,
  onResetWidth,
  onDelete,
}: Props) {
  return (
    <>
      {hasWidth && (
        <button className="context-item" onClick={onResetWidth}>
          幅を自動 (Fit) に戻す
        </button>
      )}
      <button className="context-item danger" onClick={onDelete}>
        {selectedCount > 1
          ? `選択中の${selectedCount}テーブルを図から削除`
          : "テーブルを図から削除"}
      </button>
    </>
  );
}
