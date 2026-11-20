/**
 * 図の上だけに置くテーブルを入れる画面。
 *
 * DBには作らないので、型は自由に書ける (空でもよい)。
 * 「何を持つテーブルにするか」を描いておくための画面なので、
 * 決めるのはテーブル名・日本語名と、カラムの名前・型・主キーだけにしてある
 */
import { useEffect, useRef, useState } from "react";
import { IconButton } from "../IconButton";
import { ModalFrame } from "../ModalFrame";
import {
  checkErTable,
  emptyErColumn,
  emptyErTable,
} from "../../er/newTable";
import type { ErTableColumn, ErTableSpec } from "../../er/newTable";

interface Props {
  /** 直すときは今の内容 (新しく作るなら省略) */
  initial?: ErTableSpec;
  /** 図にすでにあるテーブル名 (直すときは自分の名前を除いて渡す) */
  taken: string[];
  onDecide: (spec: ErTableSpec) => void;
  onCancel: () => void;
}

export function ErTableDialog({ initial, taken, onDecide, onCancel }: Props) {
  const [spec, setSpec] = useState<ErTableSpec>(initial ?? emptyErTable());
  const [error, setError] = useState<string | null>(null);
  const editing = initial !== undefined;
  /*
   * 開いたらテーブル名の欄へフォーカスする。
   * 共通の枠が開いたときに枠へフォーカスするので、そのあとで当て直す
   */
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const put = (v: Partial<ErTableSpec>) => setSpec((s) => ({ ...s, ...v }));

  const putCol = (i: number, v: Partial<ErTableColumn>) =>
    setSpec((s) => ({
      ...s,
      columns: s.columns.map((c, n) => (n === i ? { ...c, ...v } : c)),
    }));

  const addCol = () =>
    setSpec((s) => ({ ...s, columns: [...s.columns, emptyErColumn()] }));

  const dropCol = (i: number) =>
    setSpec((s) => {
      const columns = s.columns.filter((_, n) => n !== i);
      // 1行も無いと足せなくなるので、空の行を残す
      return { ...s, columns: columns.length > 0 ? columns : [emptyErColumn()] };
    });

  /** カラムの並べ替え (上下に1つずつ) */
  const moveCol = (i: number, d: -1 | 1) =>
    setSpec((s) => {
      const to = i + d;
      if (to < 0 || to >= s.columns.length) return s;
      const columns = [...s.columns];
      [columns[i], columns[to]] = [columns[to], columns[i]];
      return { ...s, columns };
    });

  const go = () => {
    const bad = checkErTable(spec, taken);
    if (bad) {
      setError(bad);
      return;
    }
    onDecide(spec);
  };

  return (
    <ModalFrame
      title={editing ? "テーブルを編集" : "テーブルを図に追加"}
      target={
        editing ? "図の上だけを変えます (DBは変わりません)" : "DBには作りません"
      }
      onClose={onCancel}
      className="er-table-modal"
      footer={
        <>
          <button className="btn-secondary" onClick={onCancel}>
            キャンセル
          </button>
          <button className="btn-primary" onClick={go}>
            {editing ? "保存する" : "追加する"}
          </button>
        </>
      }
    >

      <div className="form-grid">
        <label className="form-field">
          <span className="field-label">テーブル名</span>
          <input
            className="text-field mono"
            ref={nameRef}
            value={spec.name}
            spellCheck={false}
            placeholder="m_user"
            onChange={(e) => put({ name: e.target.value })}
          />
        </label>
        <label className="form-field">
          <span className="field-label">
            日本語名 <em>任意</em>
          </span>
          <input
            className="text-field"
            value={spec.logical}
            placeholder="利用者"
            onChange={(e) => put({ logical: e.target.value })}
          />
        </label>
      </div>

      <div className="er-table-cols">
        <div className="er-table-head">
          <span className="field-label">カラム</span>
          <button className="btn-ghost" onClick={addCol}>
            カラムを追加
          </button>
        </div>

        <div className="er-table-grid">
          <span className="er-table-th">名前</span>
          <span className="er-table-th">型</span>
          <span className="er-table-th">日本語名</span>
          <span className="er-table-th center">主キー</span>
          <span className="er-table-th center">NOT NULL</span>
          <span className="er-table-th" />
          {spec.columns.map((c, i) => (
            <Row
              key={i}
              col={c}
              first={i === 0}
              last={i === spec.columns.length - 1}
              onChange={(v) => putCol(i, v)}
              onUp={() => moveCol(i, -1)}
              onDown={() => moveCol(i, 1)}
              onDrop={() => dropCol(i)}
            />
          ))}
        </div>
      </div>

      {error && (
        <div className="result-banner ng">
          <span className="dot" aria-hidden />
          <span className="result-detail">{error}</span>
        </div>
      )}
    </ModalFrame>
  );
}

/** カラム1行ぶんの入力 */
function Row({
  col,
  first,
  last,
  onChange,
  onUp,
  onDown,
  onDrop,
}: {
  col: ErTableColumn;
  first: boolean;
  last: boolean;
  onChange: (v: Partial<ErTableColumn>) => void;
  onUp: () => void;
  onDown: () => void;
  onDrop: () => void;
}) {
  return (
    <>
      <input
        className="text-field mono"
        value={col.name}
        spellCheck={false}
        placeholder="user_id"
        onChange={(e) => onChange({ name: e.target.value })}
      />
      <input
        className="text-field mono"
        value={col.type}
        spellCheck={false}
        placeholder="int"
        onChange={(e) => onChange({ type: e.target.value })}
      />
      <input
        className="text-field"
        value={col.logical}
        placeholder="利用者ID"
        onChange={(e) => onChange({ logical: e.target.value })}
      />
      <span className="er-table-cell center">
        <input
          type="checkbox"
          aria-label="主キー"
          checked={col.pk}
          onChange={(e) => onChange({ pk: e.target.checked })}
        />
      </span>
      <span className="er-table-cell center">
        <input
          type="checkbox"
          aria-label="NOT NULL"
          // 主キーは必ず NOT NULL なので、選ばせない
          checked={col.pk || col.notNull}
          disabled={col.pk}
          onChange={(e) => onChange({ notNull: e.target.checked })}
        />
      </span>
      <span className="er-table-cell er-table-ops">
        <IconButton
          className="btn-ghost"
          label="上へ"
          disabled={first}
          onClick={onUp}
        >
          ↑
        </IconButton>
        <IconButton
          className="btn-ghost"
          label="下へ"
          disabled={last}
          onClick={onDown}
        >
          ↓
        </IconButton>
        <IconButton
          className="btn-ghost danger"
          label="このカラムを削除"
          onClick={onDrop}
        >
          ×
        </IconButton>
      </span>
    </>
  );
}
