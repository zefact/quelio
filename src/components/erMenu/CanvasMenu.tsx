interface Props {
  onAddTable: () => void;
  onAddFrame: () => void;
  onAddText: () => void;
}

/** 背景を右クリックしたときのメニュー */
export function CanvasMenu({ onAddTable, onAddFrame, onAddText }: Props) {
  return (
    <>
      <button className="context-item" onClick={onAddTable}>
        ここにテーブルを追加...
      </button>
      <div className="context-sep" />
      <button className="context-item" onClick={onAddFrame}>
        ここに枠を追加
      </button>
      <button className="context-item" onClick={onAddText}>
        ここにテキストを追加
      </button>
    </>
  );
}
