/** 列名を入れてもらう小さなダイアログ */
import { useEffect, useRef, useState } from "react";
import { imeBusy } from "../../ime";

interface Props {
  title: string;
  /** はじめに入っている名前 */
  initial: string;
  onDecide: (name: string) => void;
  onCancel: () => void;
  /** 入れた名前に添える注意 (同じ名前を上書きする、など。無ければ null) */
  note?: (name: string) => string | null;
}

export function CsvNameDialog({ title, initial, onDecide, onCancel, note }: Props) {
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
            if (imeBusy(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              decide();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        {note?.(name.trim()) && (
          <div className="csv-name-note">{note(name.trim())}</div>
        )}
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
