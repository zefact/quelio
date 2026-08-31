/**
 * リバースするテーブルを選ぶ画面。
 *
 * テーブルが数百あるDBで全部を読み込むと、図が使い物にならない。
 * 先に必要なものだけ選べるようにする。
 * 選ばなかったテーブルとの関連は図に出ない (選んだもの同士だけを結ぶ)。
 *
 * 既存の図を更新するときは、チェックしたものだけをDBから読み直す。
 * すでに図にあるテーブル (existing) はチェックを外したままなら今のまま残る
 */
import { useMemo, useState } from "react";
import type { TableInfo } from "../types";
import { ErModal } from "./ErModal";

export interface ErTablePickerProps {
  /** 選べるテーブル (接続先から取得したもの) */
  tables: TableInfo[];
  /** 最初から選んでおくテーブル名 */
  initial: Set<string>;
  /** すでに図にあるテーブル名 (印を付けるだけ。チェックすると更新される) */
  existing: Set<string>;
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

export function ErTablePicker({
  tables,
  initial,
  existing,
  target,
  loading,
  onClose,
  onSubmit,
}: ErTablePickerProps) {
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
      title="リバースするテーブルを選ぶ"
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
          {picked.size > 0 ? `${picked.size}件を読み込む` : "読み込む"}
        </button>
      }
    >
      <div className="er-pick">
        <div className="er-pick-head">
          <input
            className="er-pick-filter mono"
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
          <div className="er-pick-empty">
            <span className="spinner accent" /> テーブル一覧を読み込み中...
          </div>
        ) : shown.length === 0 ? (
          <div className="er-pick-empty">
            {tables.length === 0 ? "テーブルがありません" : "該当なし"}
          </div>
        ) : (
          <div className="er-pick-list">
            {shown.map((t) => {
              const name = keyOf(t);
              const inDiagram = existing.has(name);
              return (
                <label key={labelOf(t)} className="er-pick-item">
                  <input
                    type="checkbox"
                    checked={picked.has(name)}
                    onChange={() => toggle(name)}
                  />
                  <span className="mono">{labelOf(t)}</span>
                  {inDiagram && <span className="er-pick-tag">図にあり</span>}
                </label>
              );
            })}
          </div>
        )}

        <p className="er-pick-note">
          {existing.size > 0
            ? "チェックしたテーブルを図に足します。「図にあり」はチェックすると最新の内容に更新し、外したままなら今のまま残ります"
            : "選んだテーブル同士の関連だけを図にします。あとからリバースし直せば足せます"}
        </p>
      </div>
    </ErModal>
  );
}
