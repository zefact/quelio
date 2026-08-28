import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { exportQueryLog } from "../api";
import { useDismiss } from "../hooks/useDismiss";
import { usePopupPosition } from "../hooks/usePopupPosition";
import { RevealButton } from "./RevealButton";
import type { ExportedLog, LogFormat } from "../types";

/** 保存できる形式 */
const FORMATS: { value: LogFormat; label: string; hint: string }[] = [
  {
    value: "csv",
    label: "CSVで保存",
    hint: "表計算ソフトで開く用 (時刻・接続・DB・クエリの4列)",
  },
  {
    value: "text",
    label: "テキストで保存",
    hint: "1行1件のテキスト (grepしやすい形)",
  },
];

interface Props {
  /** 画面の絞り込み (この条件に一致するぶんだけ書き出す) */
  filter: string;
  /** 書き出せる記録があるか */
  hasEntries: boolean;
}

/**
 * SQLログをファイルへ書き出すボタン。
 *
 * 保存先は設定の「保存先フォルダ」(未設定ならダウンロードフォルダ)。
 * 画面で絞り込んでいるときは、その結果だけを書き出す
 */
export function ConsoleExport({ filter, hasEntries }: Props) {
  /** メニューを出す位置 (開いたときのボタンの位置。開いていなければnull) */
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ExportedLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const [menuRef, menuStyle] = usePopupPosition<HTMLDivElement>(
    at?.x ?? 0,
    at?.y ?? 0
  );
  useDismiss(!!at, () => setAt(null), {
    ref: menuRef,
    // ボタン自身を押したときは、下のトグルに任せる (閉じてすぐ開き直さない)
    inside: ".console-export-btn",
    resize: true,
    escape: true,
  });

  // 絞り込みを変えたら、前の保存結果は消す (別の条件の結果に見えてしまう)
  useEffect(() => {
    setDone(null);
    setError(null);
  }, [filter]);

  const run = async (format: LogFormat) => {
    setAt(null);
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDone(await exportQueryLog(filter, format));
    } catch (e) {
      /*
       * 「書き出す記録がありません」はバックエンドから返る普通の知らせなので、
       * エラーとして身構えさせない
       */
      const text = String(e);
      setError(
        text.includes("記録がありません")
          ? "絞り込みに一致する記録がありません"
          : `保存できません: ${text}`
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        className="btn-ghost console-export-btn"
        disabled={busy || !hasEntries}
        title={
          filter
            ? "絞り込んだ結果をファイルへ書き出します"
            : "SQLログをファイルへ書き出します"
        }
        onClick={() => {
          if (at) {
            setAt(null);
            return;
          }
          const r = btnRef.current?.getBoundingClientRect();
          setAt(r ? { x: r.left, y: r.bottom + 4 } : { x: 0, y: 0 });
        }}
      >
        {busy ? "保存中..." : "保存"}
      </button>

      {at &&
        createPortal(
          <div
            className="context-menu"
            ref={menuRef}
            style={menuStyle}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {FORMATS.map((f) => (
              <button
                key={f.value}
                className="context-item"
                title={f.hint}
                onClick={() => void run(f.value)}
              >
                {f.label}
              </button>
            ))}
            {filter && (
              <div className="context-note">
                絞り込みに一致するぶんだけ書き出します
              </div>
            )}
          </div>,
          document.body
        )}

      {done && (
        <>
          <span className="console-saved mono">
            {done.rows.toLocaleString()}件を保存: {done.path}
          </span>
          <RevealButton path={done.path} />
        </>
      )}
      {error && <span className="console-error">{error}</span>}
    </>
  );
}
