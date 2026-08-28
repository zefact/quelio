interface Props {
  /** 図から削除したテーブルの数 (0なら「戻す」を出さない) */
  removedCount: number;
  onAddFrame: () => void;
  onAddText: () => void;
  onRestoreRemoved: () => void;
}

/** 背景を右クリックしたときのメニュー */
export function CanvasMenu({
  removedCount,
  onAddFrame,
  onAddText,
  onRestoreRemoved,
}: Props) {
  return (
    <>
      <button className="context-item" onClick={onAddFrame}>
        ここに枠を追加
      </button>
      <button className="context-item" onClick={onAddText}>
        ここにテキストを追加
      </button>
      {removedCount > 0 && (
        <>
          <div className="context-sep" />
          <button className="context-item" onClick={onRestoreRemoved}>
            削除したテーブルを戻す ({removedCount})
          </button>
        </>
      )}
    </>
  );
}
