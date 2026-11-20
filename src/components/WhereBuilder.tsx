/**
 * 列・演算子・値を選んで WHERE句を作る画面。
 *
 * SQLを書き慣れていなくても絞り込めるようにする。
 * 作った文はそのまま入力欄へ入れて見せるので、何が起きたのかも分かる
 */
import { useState } from "react";
import { ModalFrame } from "./ModalFrame";
import { IconButton } from "./IconButton";
import { SelectMenu } from "./SelectMenu";
import { quoteIdentIfNeeded } from "../tableSql";
import { buildWhere, emptyCond, needsValue, OPS } from "../whereBuilder";
import type { FilterCond, OpKind } from "../whereBuilder";
import type { DbType } from "../types";

interface Props {
  /** 選べる列 (テーブルのカラム名) */
  columns: string[];
  /** 列名 → その列の型 (値に引用符を付けるかの判断に使う) */
  columnTypes: Record<string, string>;
  /** カラム名(小文字) → 日本語名 (選択肢に添える。無ければ英語名だけ) */
  columnLabels?: Record<string, string>;
  /** 最初に選んでおく列 (列ヘッダから開いたとき) */
  initialColumn?: string;
  /** 最初に並べる条件 (前に作った条件を続けて直すとき) */
  initialConds?: FilterCond[];
  /** 接続先のDB種別 (識別子の引用の要否を決める) */
  dbType: DbType;
  /**
   * 作った WHERE句と、その元になった条件を受け取る。
   * false を返すと閉じない (置き換えの確認でやめたときなど)
   */
  onApply: (
    where: string,
    conds: FilterCond[]
  ) => void | boolean | Promise<void | boolean>;
  onClose: () => void;
}

export function WhereBuilder({
  columns,
  columnTypes,
  columnLabels = {},
  initialColumn,
  initialConds,
  dbType,
  onApply,
  onClose,
}: Props) {
  const [conds, setConds] = useState<FilterCond[]>(
    () => initialConds ?? [emptyCond(initialColumn ?? columns[0] ?? "")]
  );

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

  /** 列の選択肢 (日本語名があれば添える) */
  const columnOptions = columns.map((n) => {
    const ja = columnLabels[n.toLowerCase()];
    return { value: n, label: ja ? `${n} (${ja})` : n };
  });

  return (
    <ModalFrame
      title="条件で絞り込む"
      onClose={onClose}
      className="where-modal"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn-primary"
            disabled={where === ""}
            onClick={async () => {
              if ((await onApply(where, conds)) === false) return;
              onClose();
            }}
          >
            この条件で絞り込む
          </button>
        </>
      }
    >
      {/* 作れるのは AND だけ。OR が要るときは入力欄に直接書いてもらう */}
      <p className="where-note">
        すべての条件を満たす行 (AND) に絞り込みます。「どれか1つ」(OR) にしたいときは、入力欄に直接書いてください
      </p>

      <div className="where-rows">
        {conds.map((c, i) => (
          <div className="where-row" key={i}>
            <span className="where-join">{i === 0 ? "条件" : "かつ"}</span>
            <SelectMenu
              className="mono"
              value={c.column}
              options={columnOptions}
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
            <IconButton
              className="btn-ghost where-del"
              label="この条件を削除"
              disabled={conds.length === 1}
              onClick={() => setConds((p) => p.filter((_, n) => n !== i))}
            >
              ✕
            </IconButton>
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
    </ModalFrame>
  );
}
