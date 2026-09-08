/**
 * ツールバーの「固定長」から開くメニュー。
 *
 * 固定長のファイルは、同じ桁設定を繰り返し使う。
 * 一度お気に入りに登録しておけば、ここから選ぶだけで読み直せる
 * (桁設定のダイアログを開く必要がない)
 */
import { useEffect, useRef } from "react";
import type { CsvSavedLayout } from "../../types";
import { UNIT_LABEL, totalWidth } from "./csvFixed";

interface Props {
  /** 今このファイルを固定長として読んでいるか */
  fixed: boolean;
  /** お気に入りに登録した桁設定 */
  layouts: CsvSavedLayout[];
  /** 今このファイルに使われているお気に入りの名前 (無ければ null) */
  applied: string | null;
  /** お気に入りの桁設定で読み直す */
  onUse: (s: CsvSavedLayout) => void;
  /** お気に入りを削除する */
  onDelete: (s: CsvSavedLayout) => void;
  /** 桁設定のダイアログを開く */
  onEdit: () => void;
  /** 区切り文字として読み直す */
  onUseDelimiter: () => void;
  onClose: () => void;
}

export function CsvFixedMenu({
  fixed,
  layouts,
  applied,
  onUse,
  onDelete,
  onEdit,
  onUseDelimiter,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // メニューの外を触ったら閉じる
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  return (
    <div className="csv-fixed-menu" ref={ref}>
      <div className="csv-key-head">お気に入り</div>
      {layouts.length === 0 ? (
        <div className="csv-empty-hint">
          登録されていません。桁設定のダイアログから保存できます
        </div>
      ) : (
        layouts.map((s) => (
          <div className="csv-fixed-menu-row" key={s.name}>
            <button
              className={
                "context-item" + (applied === s.name ? " csv-fixed-applied" : "")
              }
              title={
                (applied === s.name ? "このファイルに使われています\n" : "") +
                `${s.layout.columns.length}桁 (計${totalWidth(
                  s.layout.columns
                )}${UNIT_LABEL[s.layout.unit]})`
              }
              onClick={() => onUse(s)}
            >
              {/* 幅を取っておくと、印の有無で名前の頭が動かない */}
              <span className="csv-fixed-menu-check" aria-hidden>
                {applied === s.name ? "✓" : ""}
              </span>
              <span className="csv-fixed-menu-name">{s.name}</span>
              <span className="csv-fixed-menu-note mono">
                {s.layout.columns.length}桁
              </span>
            </button>
            <button
              className="btn-ghost csv-fixed-del"
              title="このお気に入りを削除"
              onClick={() => onDelete(s)}
            >
              ✕
            </button>
          </div>
        ))
      )}

      <div className="context-sep" />

      <button className="context-item" onClick={onEdit}>
        {fixed ? "桁設定を変更..." : "固定長の桁を設定..."}
      </button>
      {fixed && (
        <button className="context-item" onClick={onUseDelimiter}>
          区切り文字として読み直す
        </button>
      )}
    </div>
  );
}
