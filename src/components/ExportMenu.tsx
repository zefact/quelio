import { useRef, useState } from "react";
import { useDismiss } from "../hooks/useDismiss";
import { usePopupPosition } from "../hooks/usePopupPosition";
import {
  TARGET_LABEL,
  lastExportTarget,
  rememberExportTarget,
} from "../exportFormat";
import type { ExportTarget } from "../exportFormat";

interface Props {
  /** 出力中は押せなくする */
  disabled: boolean;
  /** 出力中の表示に切り替える */
  running: boolean;
  /** 実行計画を表示中か (説明の文言が変わる) */
  explainKind: "explain" | "analyze" | null;
  /** 選んだ持ち出し先で実行する */
  onRun: (target: ExportTarget) => void;
}

/** 選べる持ち出し先 (並び順はそのままメニューの並びになる) */
const TARGETS: { value: ExportTarget; note: string }[] = [
  { value: "csv", note: "他のツールへ渡すとき" },
  { value: "xlsx", note: "見出し・絞り込み付き" },
  { value: "editor", note: "全件を開いて編集・比較" },
];

/**
 * 結果の持ち出しボタン。
 *
 * 持ち出し先は人によってほぼ決まっているので、毎回選ばせない。
 * ボタンを押すと前に選んだ先へそのまま出し、
 * 「▾」で先を選び直せる形にする。
 * ▾ で選んでもその場では動かさない (選ぶ操作と、動かす操作を分ける)
 */
export function ExportMenu({ disabled, running, explainKind, onRun }: Props) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ x: 0, y: 0, top: 0 });
  /** 今選んでいる持ち出し先 (前に選んだものから始める) */
  const [target, setTarget] = useState<ExportTarget>(lastExportTarget);
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

  const tip = explainKind
    ? "画面に出ている実行計画を保存します\n(SQLは実行し直しません)"
    : target === "editor"
      ? "この結果タブのSQLを全件取り出して、CSVエディタのタブとして開きます"
      : "この結果タブのSQLを全件保存します\n1000行を超えても全行出力します";

  const openMenu = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setAt({ x: r.right - 220, y: r.bottom + 4, top: r.top - 4 });
    setOpen((v) => !v);
  };

  /** 持ち出し先を選ぶ (ここでは動かさない) */
  const pick = (value: ExportTarget) => {
    setOpen(false);
    setTarget(value);
    rememberExportTarget(value);
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
        onClick={() => onRun(target)}
      >
        {running ? (
          <>
            <span className="spinner accent" />{" "}
            {target === "editor" ? "取得中..." : "出力中..."}
          </>
        ) : (
          TARGET_LABEL[target]
        )}
      </button>
      <button
        className="btn-secondary csv-btn export-caret"
        title="持ち出し先を選ぶ"
        aria-label="持ち出し先を選ぶ"
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
          {TARGETS.map((t) => (
            <button
              key={t.value}
              className={
                "context-item export-item" +
                (t.value === target ? " checked" : "")
              }
              onClick={() => pick(t.value)}
            >
              <span className="export-name">{TARGET_LABEL[t.value]}</span>
              <span className="export-note">{t.note}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
