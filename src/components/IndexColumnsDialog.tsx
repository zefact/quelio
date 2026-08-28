import { useState } from "react";
import { useModal } from "../hooks/useModal";
import type { ColumnInfo } from "../types";

interface Props {
  /** テーブルの全カラム */
  columns: ColumnInfo[];
  /** 現在選ばれているカラム (並び順どおり) */
  value: string[];
  /** 決定したときに呼ばれる */
  onDecide: (columns: string[]) => void;
  onClose: () => void;
}

function ArrowIcon({ up }: { up: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d={up ? "M12 19V5M5 12l7-7 7 7" : "M12 5v14M5 12l7 7 7-7"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * インデックスの対象カラムを選ぶダイアログ。
 *
 * 複合インデックスは並び順で効き方が変わるため、
 * 選んだ順にリストへ積み上げて、上下で入れ替えられるようにする
 */
export function IndexColumnsDialog({
  columns,
  value,
  onDecide,
  onClose,
}: Props) {
  const [picked, setPicked] = useState<string[]>(value);

  const add = (name: string) => setPicked((cur) => [...cur, name]);
  const remove = (i: number) =>
    setPicked((cur) => cur.filter((_, idx) => idx !== i));

  /** i番目を1つ上/下へ入れ替える */
  const swap = (i: number, to: number) =>
    setPicked((cur) => {
      if (to < 0 || to >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[to]] = [next[to], next[i]];
      return next;
    });

  /** まだ選ばれていないカラム */
  const rest = columns.filter((c) => !picked.includes(c.name));


  // Escで閉じる・初期フォーカスは共通の作法にそろえる
  const boxRef = useModal(onClose);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal index-cols-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" && picked.length > 0) onDecide(picked);
        }}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            対象カラムを選ぶ
            <span className="column-modal-target">
              上にあるカラムから順に効きます
            </span>
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる">
            ×
          </button>
        </div>

        <div className="index-cols-body">
          <div className="index-cols-pane">
            <p className="column-note">
              選択済み <span className="panel-count">{picked.length}</span>
            </p>
            {picked.length === 0 ? (
              <p className="index-cols-empty">
                下の一覧からカラムをクリックして追加してください
              </p>
            ) : (
              <ol className="index-cols-picked">
                {picked.map((name, i) => (
                  <li key={name}>
                    <span className="index-cols-no mono">{i + 1}</span>
                    <span className="index-cols-name mono">{name}</span>
                    <button
                      className="pane-icon-btn"
                      title="1つ上へ"
                      disabled={i === 0}
                      onClick={() => swap(i, i - 1)}
                    >
                      <ArrowIcon up />
                    </button>
                    <button
                      className="pane-icon-btn"
                      title="1つ下へ"
                      disabled={i === picked.length - 1}
                      onClick={() => swap(i, i + 1)}
                    >
                      <ArrowIcon up={false} />
                    </button>
                    <button
                      className="pane-icon-btn danger"
                      title="外す"
                      onClick={() => remove(i)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="index-cols-pane">
            <p className="column-note">
              追加できるカラム{" "}
              <span className="panel-count">{rest.length}</span>
            </p>
            <div className="index-cols-choices">
              {rest.map((c) => (
                <button
                  key={c.name}
                  className="index-cols-choice mono"
                  onClick={() => add(c.name)}
                  title={c.colType}
                >
                  {c.name}
                  <span className="index-cols-type">{c.colType}</span>
                </button>
              ))}
              {rest.length === 0 && (
                <p className="index-cols-empty">すべて選択済みです</p>
              )}
            </div>
          </div>
        </div>

        <div className="modal-actions column-modal-actions">
          <span className="toolbar-spacer" />
          <button className="btn-secondary" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn-primary"
            disabled={picked.length === 0}
            onClick={() => onDecide(picked)}
          >
            決定
          </button>
        </div>
      </div>
    </div>
  );
}
