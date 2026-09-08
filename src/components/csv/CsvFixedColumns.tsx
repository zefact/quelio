/**
 * 固定長の桁の並びを決める表。
 *
 * データ行・ヘッダ行・トレーラ行で同じものを使うので、部品として切り出してある
 */
import { useState } from "react";
import type { CsvAlign, CsvFixedColumn, CsvWidthUnit } from "../../types";
import { SelectMenu } from "../SelectMenu";
import {
  UNIT_LABEL,
  newColumn,
  parseWidths,
  totalWidth,
  widthsText,
} from "./csvFixed";

/** 配置の選択肢 */
const ALIGNS = [
  { value: "left", label: "左" },
  { value: "right", label: "右" },
];

/** 埋め文字の選択肢 */
const PADS = [
  { value: " ", label: "空白" },
  { value: "0", label: "0" },
];

interface Props {
  columns: CsvFixedColumn[];
  /** 桁幅の単位 (合計の表示に使う) */
  unit: CsvWidthUnit;
  onChange: (columns: CsvFixedColumn[]) => void;
}

export function CsvFixedColumns({ columns, unit, onChange }: Props) {
  /** 桁幅を一括入力する欄 */
  const [bulk, setBulk] = useState(() => widthsText(columns));

  /** 桁を差し替える (一括入力欄も合わせる) */
  const put = (next: CsvFixedColumn[]) => {
    setBulk(widthsText(next));
    onChange(next);
  };

  /** 桁を1つ変更する */
  const patch = (at: number, fix: Partial<CsvFixedColumn>) => {
    put(columns.map((c, i) => (i === at ? { ...c, ...fix } : c)));
  };

  /** 一括入力した桁幅を反映する (同じ位置の詰め方と項目名は残す) */
  const applyBulk = (text: string) => {
    setBulk(text);
    const widths = parseWidths(text);
    if (widths.length === 0) return;
    onChange(
      widths.map((w, i) => {
        const old = columns[i];
        return old ? { ...old, width: w } : newColumn(w);
      })
    );
  };

  const total = totalWidth(columns);

  return (
    <>
      <div className="csv-form-row">
        <span>桁幅を一括入力</span>
        <input
          className="csv-name-box csv-bulk"
          placeholder="10,8,20,4"
          value={bulk}
          onChange={(e) => applyBulk(e.target.value)}
        />
      </div>

      <div className="csv-fixed-list">
        <div className="csv-fixed-head">
          <span>#</span>
          <span>桁幅</span>
          <span>配置</span>
          <span>埋め文字</span>
          <span>項目名</span>
          <span />
        </div>
        {columns.map((c, i) => (
          <div className="csv-fixed-row" key={i}>
            <span className="mono csv-fixed-no">{i + 1}</span>
            <input
              className="csv-fixed-w mono"
              type="number"
              min={1}
              value={c.width}
              onChange={(e) =>
                patch(i, { width: Math.max(1, +e.target.value || 1) })
              }
            />
            <SelectMenu
              popFixed
              value={c.align}
              options={ALIGNS}
              onChange={(v) => patch(i, { align: v as CsvAlign })}
            />
            <SelectMenu
              popFixed
              value={c.pad}
              options={PADS}
              onChange={(pad) => patch(i, { pad })}
            />
            <input
              className="csv-fixed-name"
              placeholder={`${i + 1}`}
              value={c.name}
              onChange={(e) => patch(i, { name: e.target.value })}
            />
            <button
              className="btn-ghost csv-fixed-del"
              title="この桁を削除"
              disabled={columns.length <= 1}
              onClick={() => put(columns.filter((_, at) => at !== i))}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="csv-fixed-foot">
          <button
            className="btn-secondary"
            onClick={() => put([...columns, newColumn(10)])}
          >
            桁を追加
          </button>
          <span className="toolbar-spacer" />
          <span className="mono">
            計 {total}
            {UNIT_LABEL[unit]}
          </span>
        </div>
      </div>
    </>
  );
}
