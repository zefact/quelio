interface Props {
  table: string;
  /** 幅を手で変えてあるか (「自動に戻す」を出すかの判断) */
  hasWidth: boolean;
  /** 図の上だけで作ったテーブルか (メニューの文言を変えるのに使う) */
  manual: boolean;
  /** まとめて削除する対象 (1件ならこのテーブルだけ) */
  selectedCount: number;
  onResetWidth: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** テーブルの見出しを右クリックしたときのメニュー */
export function NodeMenu({
  hasWidth,
  manual,
  selectedCount,
  onResetWidth,
  onEdit,
  onDelete,
}: Props) {
  return (
    <>
      {/*
        * DBから読んだテーブルも直せる。
        * 直せるのは図の見た目だけで、DBは変わらない
        */}
      <button className="context-item" onClick={onEdit}>
        {manual ? "テーブルを直す..." : "テーブルを直す... (図の上だけ)"}
      </button>
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
