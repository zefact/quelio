import { useRef, useState } from "react";
import { useDismiss } from "../hooks/useDismiss";
import { usePopupPosition } from "../hooks/usePopupPosition";
import { CaretIcon } from "./SqlToolIcons";
import {
  ER_FORMATS,
  formatLabel,
  isTextFormat,
  lastErFormat,
  rememberErFormat,
  type ErExportFormat,
  type ErTextFormat,
} from "../er/exportFormat";

interface Props {
  /** 図が空のときは押せなくする */
  disabled: boolean;
  /** 選んでいる形式で保存する */
  onSave: (format: ErExportFormat) => void;
  /** テキスト形式をクリップボードへコピーする */
  onCopy: (format: ErTextFormat) => void;
}

/** メニューの幅 (右端をボタンに揃えるのに使う) */
const MENU_W = 300;

/**
 * ER図の保存ボタン (Excel / PNG / SVG / Mermaid / PlantUML)。
 *
 * 押すと前に選んだ形式でそのまま保存し、「▾」で形式を選び直す。
 * ▾ で選んでもその場では保存しない (選ぶ操作と保存する操作を分ける)。
 * テキスト形式はメニューの行からクリップボードへコピーもできる
 */
export function ErSaveMenu({ disabled, onSave, onCopy }: Props) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ x: 0, y: 0, top: 0 });
  /** 今選んでいる形式 (前に選んだものから始める) */
  const [format, setFormat] = useState<ErExportFormat>(lastErFormat);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menuRef, menuStyle] = usePopupPosition<HTMLDivElement>(
    at.x,
    at.y,
    at.top
  );
  useDismiss(open, () => setOpen(false), {
    // 図の上の要素がmousedownを止めるので、キャプチャ段階で拾う。
    // ▾ もメニューも外枠の中にあるので、外枠の外だけを「外側」とする
    capture: true,
    ref: wrapRef,
    resize: true,
    escape: true,
  });

  const openMenu = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setAt({ x: r.right - MENU_W, y: r.bottom + 4, top: r.top - 4 });
    setOpen((v) => !v);
  };

  /** 形式を選ぶ (ここでは保存しない) */
  const pick = (value: ErExportFormat) => {
    setOpen(false);
    setFormat(value);
    rememberErFormat(value);
  };

  const note = ER_FORMATS.find((f) => f.value === format)?.note ?? "";

  return (
    <div className="run-split export-split" ref={wrapRef}>
      <button
        className={
          "btn-secondary export-main tooltip-left" +
          (open ? "" : " has-tooltip tooltip-wrap")
        }
        data-tooltip={`${formatLabel(format)}で保存します (${note})\n形式は ▾ で切り替えられます`}
        disabled={disabled}
        onClick={() => onSave(format)}
      >
        {formatLabel(format)}保存
      </button>
      <button
        className="btn-secondary export-caret"
        title="保存する形式を選ぶ"
        aria-label="保存する形式を選ぶ"
        disabled={disabled}
        onClick={openMenu}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <CaretIcon />
      </button>
      {open && (
        <div
          className="context-menu export-menu er-save-menu"
          ref={menuRef}
          style={menuStyle}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {ER_FORMATS.map((f) => (
              <div key={f.value} className="er-save-row">
                <button
                  className={
                    "context-item export-item" +
                    (f.value === format ? " checked" : "")
                  }
                  onClick={() => pick(f.value)}
                >
                  <span className="export-name">{f.label}</span>
                  <span className="export-note">{f.note}</span>
                </button>
                {isTextFormat(f.value) && (
                  <CopyButton
                    format={f.value}
                    label={f.label}
                    onCopy={(v) => {
                      setOpen(false);
                      onCopy(v);
                    }}
                  />
                )}
              </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** テキスト形式の行に付ける「コピー」 */
function CopyButton({
  format,
  label,
  onCopy,
}: {
  format: ErTextFormat;
  label: string;
  onCopy: (format: ErTextFormat) => void;
}) {
  return (
    <button
      className="context-item er-save-copy"
      title={`${label}をクリップボードへコピー`}
      onClick={() => onCopy(format)}
    >
      コピー
    </button>
  );
}
