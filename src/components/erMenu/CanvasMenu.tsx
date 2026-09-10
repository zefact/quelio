interface Props {
  onAddFrame: () => void;
  onAddText: () => void;
}

/** 背景を右クリックしたときのメニュー */
export function CanvasMenu({ onAddFrame, onAddText }: Props) {
  return (
    <>
      <button className="context-item" onClick={onAddFrame}>
        ここに枠を追加
      </button>
      <button className="context-item" onClick={onAddText}>
        ここにテキストを追加
      </button>
    </>
  );
}
