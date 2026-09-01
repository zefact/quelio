/**
 * テーブルを選ぶ画面 (ER図のリバース・定義書の出力で使う)。
 *
 * テーブルが数百あるDBで全部を対象にすると、出来上がったものが使い物にならない。
 * 先に必要なものだけ選べるようにする。
 *
 * 見出し・ボタンの文言・説明は使う側から渡す。
 * ER図の更新のように、すでに入っているものへ印を付けたい場合は existing を渡す
 */
import { useMemo, useState } from "react";
import type { TableInfo } from "../types";
import { ErModal } from "./ErModal";

export interface TablePickerProps {
  /** 選べるテーブル (接続先から取得したもの) */
  tables: TableInfo[];
  /** 最初から選んでおくテーブル名 */
  initial: Set<string>;
  /** すでに入っているテーブル名 (「図にあり」の印を付ける。空でよい) */
  existing: Set<string>;
  /** 画面の見出し */
  title: string;
  /** 決定ボタンの文言を作る (選んだ件数を受け取る) */
  submitLabel: (count: number) => string;
  /** 一覧の下に出す説明 */
  note: string;
  /** 見出しの下に出す接続名 / DB名 */
  target: string;
  /** 読み込み中か (一覧の取得待ち) */
  loading: boolean;
  onClose: () => void;
  onSubmit: (names: Set<string>) => void;
}

/** 図の中でテーブルを見分けるキー */
function keyOf(t: TableInfo): string {
  return t.name;
}

/** 一覧に出す名前 (スキーマがあれば添える) */
function labelOf(t: TableInfo): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

export function TablePicker({
  tables,
  initial,
  existing,
  title,
  submitLabel,
  note,
  target,
  loading,
  onClose,
  onSubmit,
}: TablePickerProps) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial));
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) => labelOf(t).toLowerCase().includes(q));
  }, [tables, filter]);

  const toggle = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  /** 絞り込んで出ている分だけをまとめて切り替える */
  const setShown = (on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const t of shown) {
        if (on) next.add(keyOf(t));
        else next.delete(keyOf(t));
      }
      return next;
    });

  return (
    <ErModal
      icon="⟳"
      title={title}
      sub={target}
      subMono
      wide
      onClose={onClose}
      actions={
        <button
          className="btn-primary"
          disabled={loading || picked.size === 0}
          onClick={() => onSubmit(picked)}
        >
          {submitLabel(picked.size)}
        </button>
      }
    >
      <div className="table-pick">
        <div className="table-pick-head">
          <input
            className="table-pick-filter mono"
            placeholder="絞り込み..."
            value={filter}
            autoFocus
            onChange={(e) => setFilter(e.target.value)}
          />
          <button className="btn-secondary" onClick={() => setShown(true)}>
            すべて選ぶ
          </button>
          <button className="btn-secondary" onClick={() => setShown(false)}>
            すべて外す
          </button>
        </div>

        {loading ? (
          <div className="table-pick-empty">
            <span className="spinner accent" /> テーブル一覧を読み込み中...
          </div>
        ) : shown.length === 0 ? (
          <div className="table-pick-empty">
            {tables.length === 0 ? "テーブルがありません" : "該当なし"}
          </div>
        ) : (
          <div className="table-pick-list">
            {shown.map((t) => {
              const name = keyOf(t);
              const inDiagram = existing.has(name);
              return (
                <label key={labelOf(t)} className="table-pick-item">
                  <input
                    type="checkbox"
                    checked={picked.has(name)}
                    onChange={() => toggle(name)}
                  />
                  <span className="mono">{labelOf(t)}</span>
                  {inDiagram && <span className="table-pick-tag">図にあり</span>}
                </label>
              );
            })}
          </div>
        )}

        <p className="table-pick-note">{note}</p>
      </div>
    </ErModal>
  );
}
