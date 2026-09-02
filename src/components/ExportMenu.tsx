import { useRef, useState } from "react";
import { useDismiss } from "../hooks/useDismiss";
import { usePopupPosition } from "../hooks/usePopupPosition";
import { FORMAT_LABEL, lastExportFormat } from "../exportFormat";
import type { ExportFormat } from "../exportFormat";

interface Props {
  /** 出力中は押せなくする */
  disabled: boolean;
  /** 出力中の表示に切り替える */
  running: boolean;
  /** 実行計画を表示中か (説明の文言が変わる) */
  explainKind: "explain" | "analyze" | null;
  onExport: (format: ExportFormat) => void;
}

/** 選べる形式 (並び順はそのままメニューの並びになる) */
const FORMATS: { value: ExportFormat; note: string }[] = [
  { value: "csv", note: "他のツールへ渡すとき" },
  { value: "xlsx", note: "見出し・絞り込み付き" },
];

/**
 * 結果の書き出しボタン。
 *
 * 形式は人によってほぼ決まっているので、毎回選ばせない。
 * ボタンを押すと前に選んだ形式でそのまま出し、
 * 「▾」からもう一方を選べる形にする
 */
export function ExportMenu({ disabled, running, explainKind, onExport }: Props) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ x: 0, y: 0, top: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menuRef, menuStyle] = usePopupPosition<HTMLDivElement>(
    at.x,
    at.y,
    at.top
  );
  useDismiss(open, () => setOpen(false), {
    ref: menuRef,
    resize: true,
    escape: true,
  });

  const current = lastExportFormat();
  const tip = explainKind
    ? "画面に出ている実行計画を保存します\n(SQLは実行し直しません)"
    : "この結果タブのSQLを全件保存します\n1000行を超えても全行出力します";

  const openMenu = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setAt({ x: r.right - 200, y: r.bottom + 4, top: r.top - 4 });
    setOpen((v) => !v);
  };

  const pick = (format: ExportFormat) => {
    setOpen(false);
    onExport(format);
  };

  return (
    <div className="run-split export-split" ref={wrapRef}>
      <button
        // 画面右端のボタンなので、ツールチップは右端起点で左へ伸ばす
        className={
          "btn-secondary csv-btn export-main" +
          (open ? "" : " has-tooltip tooltip-wrap")
        }
        data-tooltip={tip}
        disabled={disabled}
        onClick={() => onExport(current)}
      >
        {running ? (
          <>
            <span className="spinner accent" /> 出力中...
          </>
        ) : (
          `${FORMAT_LABEL[current]}ダウンロード`
        )}
      </button>
      <button
        className="btn-secondary csv-btn export-caret"
        title="書き出す形式を選ぶ"
        aria-label="書き出す形式を選ぶ"
        disabled={disabled}
        onClick={openMenu}
        onMouseDown={(e) => e.stopPropagation()}
      >
        ▾
      </button>
      {open && (
        <div
          className="context-menu export-menu"
          ref={menuRef}
          style={menuStyle}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {FORMATS.map((f) => (
            <button
              key={f.value}
              className={
                "context-item export-item" +
                (f.value === current ? " checked" : "")
              }
              onClick={() => pick(f.value)}
            >
              <span className="export-name">{FORMAT_LABEL[f.value]}</span>
              <span className="export-note">{f.note}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
