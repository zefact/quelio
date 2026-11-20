import { useRef, useState } from "react";
import { useDismiss } from "../hooks/useDismiss";
import { usePopupPosition } from "../hooks/usePopupPosition";
import { CaretIcon } from "./SqlToolIcons";
import {
  ER_FORMATS,
  isTextFormat,
  lastErFormat,
  rememberErFormat,
  type ErExportFormat,
  type ErTextFormat,
} from "../er/exportFormat";

interface Props {
  /** 図が空のときは押せなくする */
  disabled: boolean;
  /** 選んだ形式でファイルへ書き出す */
  onSave: (format: ErExportFormat) => void;
  /** テキスト形式をクリップボードへコピーする */
  onCopy: (format: ErTextFormat) => void;
}

/** メニューの幅 (右端をボタンに揃えるのに使う) */
const MENU_W = 300;

/**
 * ER図の書き出しボタン (Excel / PNG / SVG / Mermaid / PlantUML)。
 *
 * 図そのものは自動で保存されるので、ここは「ファイルへ書き出す」だけ。
 * 「保存」と書くと、押さないと図が消えるように読めるため、「書き出す ▾」にしている。
 * 形式の行を押すとその形式で書き出す。前に使った形式には印を付ける。
 * テキスト形式はメニューの行からクリップボードへコピーもできる
 */
export function ErSaveMenu({ disabled, onSave, onCopy }: Props) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ x: 0, y: 0, top: 0 });
  /** 前に使った形式 (印を付ける) */
  const [format, setFormat] = useState<ErExportFormat>(lastErFormat);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menuRef, menuStyle] = usePopupPosition<HTMLDivElement>(
    at.x,
    at.y,
    at.top
  );
  useDismiss(open, () => setOpen(false), {
    // 図の上の要素がmousedownを止めるので、キャプチャ段階で拾う。
    // ボタンもメニューも外枠の中にあるので、外枠の外だけを「外側」とする
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

  /** その形式で書き出し、次に開いたときの印にする */
  const pick = (value: ErExportFormat) => {
    setOpen(false);
    setFormat(value);
    rememberErFormat(value);
    onSave(value);
  };

  return (
    <div className="er-export" ref={wrapRef}>
      <button
        className="btn-secondary tooltip-left has-tooltip"
        // メニューを開いている間は、説明がメニューに重ならないよう出さない
        data-tooltip={
          open
            ? undefined
            : disabled
              ? "図が空なので書き出せません"
              : "図をファイルへ書き出します (Excel / PNG / SVG / Mermaid / PlantUML)\n図そのものは自動で保存されています"
        }
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={openMenu}
        onMouseDown={(e) => e.stopPropagation()}
      >
        書き出す <CaretIcon />
      </button>
      {open && (
        <div
          className="context-menu export-menu er-save-menu"
          ref={menuRef}
          style={menuStyle}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {ER_FORMATS.map((f) => (
            <div key={f.value} className="er-save-row">
              <button
                className={
                  "context-item export-item has-tooltip" +
                  (f.value === format ? " checked" : "")
                }
                role="menuitem"
                data-tooltip={f.value === format ? "前回使った形式" : undefined}
                onClick={() => pick(f.value)}
              >
                <span className="export-name">{f.label}で書き出す</span>
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
      className="context-item er-save-copy has-tooltip"
      data-tooltip={`${label}をクリップボードへコピー`}
      onClick={() => onCopy(format)}
    >
      コピー
    </button>
  );
}
