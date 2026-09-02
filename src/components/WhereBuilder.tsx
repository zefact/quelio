/**
 * 列・演算子・値を選んで WHERE句を作る画面。
 *
 * SQLを書き慣れていなくても絞り込めるようにする。
 * 作った文はそのまま入力欄へ入れて見せるので、何が起きたのかも分かる
 */
import { useState } from "react";
import { useModal } from "../hooks/useModal";
import { SelectMenu } from "./SelectMenu";
import { quoteIdentIfNeeded } from "../tableSql";
import { buildWhere, needsValue, OPS } from "../whereBuilder";
import type { FilterCond, OpKind } from "../whereBuilder";
import type { DbType } from "../types";

interface Props {
  /** 選べる列 (テーブルのカラム名) */
  columns: string[];
  /** 列名 → その列の型 (値に引用符を付けるかの判断に使う) */
  columnTypes: Record<string, string>;
  /** 最初に選んでおく列 (列ヘッダから開いたとき) */
  initialColumn?: string;
  /** 接続先のDB種別 (識別子の引用の要否を決める) */
  dbType: DbType;
  /** 作った WHERE句を受け取る */
  onApply: (where: string) => void;
  onClose: () => void;
}

/** 条件の初期値 */
function emptyCond(column: string): FilterCond {
  return { column, op: "eq", value: "" };
}

export function WhereBuilder({
  columns,
  columnTypes,
  initialColumn,
  dbType,
  onApply,
  onClose,
}: Props) {
  const boxRef = useModal(onClose);
  const [conds, setConds] = useState<FilterCond[]>([
    emptyCond(initialColumn ?? columns[0] ?? ""),
  ]);

  const patch = (i: number, p: Partial<FilterCond>) =>
    setConds((prev) => prev.map((c, n) => (n === i ? { ...c, ...p } : c)));

  /*
   * 列名は必要なときだけ引用する。
   * `id` のように引用しなくてよい名前まで囲むと、
   * 出来上がった条件が読みにくくなるため。
   *
   * 値の引用は列の型で決める。
   * 値の見た目だけで決めると `varchar` の "0123" が数値になってしまう
   */
  const where = buildWhere(
    conds,
    (n) => quoteIdentIfNeeded(dbType, n),
    (n) => columnTypes[n]
  );

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal where-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">条件で絞り込む</span>
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        <div className="where-rows">
          {conds.map((c, i) => (
            <div className="where-row" key={i}>
              <span className="where-join">{i === 0 ? "条件" : "かつ"}</span>
              <SelectMenu
                className="mono"
                value={c.column}
                options={columns.map((n) => ({ value: n, label: n }))}
                onChange={(v) => patch(i, { column: v })}
                popFixed
              />
              <SelectMenu
                value={c.op}
                options={OPS.map((o) => ({ value: o.id, label: o.label }))}
                onChange={(v) => patch(i, { op: v as OpKind })}
                popFixed
              />
              {needsValue(c.op) ? (
                <input
                  className="filter-input mono where-value"
                  value={c.value}
                  placeholder="値"
                  onChange={(e) => patch(i, { value: e.target.value })}
                />
              ) : (
                <span className="where-value-none">値は使いません</span>
              )}
              <button
                className="btn-ghost where-del"
                title="この条件を削除"
                disabled={conds.length === 1}
                onClick={() => setConds((p) => p.filter((_, n) => n !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <button
          className="btn-secondary where-add"
          onClick={() =>
            setConds((p) => [...p, emptyCond(initialColumn ?? columns[0] ?? "")])
          }
        >
          条件を追加
        </button>

        <div className="where-preview">
          <span className="where-preview-label">できあがるWHERE句</span>
          <code className="mono">{where || "(条件なし)"}</code>
        </div>
        <p className="where-note">
          「含む」などは LIKE になります。値の中の % と _ はワイルドカードとして働きます
        </p>

        <div className="modal-actions">
          <span className="toolbar-spacer" />
          <button className="btn-ghost" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn-primary"
            disabled={where === ""}
            onClick={() => {
              onApply(where);
              onClose();
            }}
          >
            この条件で絞り込む
          </button>
        </div>
      </div>
    </div>
  );
}
