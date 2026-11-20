/** 列名を入れてもらう小さなダイアログ */
import { useEffect, useRef, useState } from "react";
import { imeBusy } from "../../ime";
import { ModalFrame } from "../ModalFrame";

interface Props {
  title: string;
  /** 決めるボタンの文言 (何をするかを動詞で書く) */
  confirmLabel: string;
  /** はじめに入っている名前 */
  initial: string;
  onDecide: (name: string) => void;
  onCancel: () => void;
  /** 入れた名前に添える注意 (同じ名前を上書きする、など。無ければ null) */
  note?: (name: string) => string | null;
}

export function CsvNameDialog({
  title,
  confirmLabel,
  initial,
  onDecide,
  onCancel,
  note,
}: Props) {
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
    <ModalFrame
      title={title}
      onClose={onCancel}
      className="csv-name-modal"
      footer={
        <>
          <button className="btn-secondary" onClick={onCancel}>
            キャンセル
          </button>
          <button className="btn-primary" disabled={!name.trim()} onClick={decide}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <input
        ref={ref}
        className="csv-name-box"
        value={name}
        aria-label={title}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (imeBusy(e)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            decide();
          }
        }}
      />
      {note?.(name.trim()) && (
        <div className="csv-name-note">{note(name.trim())}</div>
      )}
    </ModalFrame>
  );
}
