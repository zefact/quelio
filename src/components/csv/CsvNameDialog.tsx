/** 列名を入れてもらう小さなダイアログ */
import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  /** はじめに入っている名前 */
  initial: string;
  onDecide: (name: string) => void;
  onCancel: () => void;
}

export function CsvNameDialog({ title, initial, onDecide, onCancel }: Props) {
  const [name, setName] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const decide = () => {
    const v = name.trim();
    if (v) onDecide(v);
  };

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div
        className="modal csv-name-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-title">{title}</div>
        <input
          ref={ref}
          className="csv-name-box"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              decide();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <div className="modal-actions csv-modal-actions">
          <button className="btn-secondary" onClick={onCancel}>
            キャンセル
          </button>
          <button className="btn-primary" disabled={!name.trim()} onClick={decide}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
