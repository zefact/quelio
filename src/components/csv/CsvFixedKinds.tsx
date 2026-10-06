/**
 * 固定長の「レコードの種別」1つぶんの決まり。
 *
 * 決まった場所の値でレコードの種別を見分け、種別ごとに違う桁で切る。
 * 見る場所は種別ごとに決められる (ファイルによって印の位置が違うため)。
 *
 * 桁の並びそのものはダイアログ側で出すので、ここは名前と見分け方だけを持つ
 */
import type { CsvFixedKind, CsvWidthUnit } from "../../types";
import { UNIT_LABEL } from "./csvFixed";

interface Props {
  kind: CsvFixedKind;
  unit: CsvWidthUnit;
  onChange: (fix: Partial<CsvFixedKind>) => void;
  /** この種別をやめる */
  onRemove: () => void;
}

export function CsvFixedKindPart({ kind, unit, onChange, onRemove }: Props) {
  return (
    <div className="csv-fixed-kind">
      <label className="save-sql-label csv-fixed-kind-name">
        種別の名前
        <input
          className="save-sql-input"
          placeholder="ヘッダ"
          value={kind.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </label>

      <button
        type="button"
        className="btn-ghost danger csv-fixed-kind-del"
        title="この種別をやめる"
        onClick={onRemove}
      >
        種別を削除
      </button>

      <div className="save-sql-label csv-fixed-kind-where">
        見分け方
        <div className="csv-key-where">
          <input
            className="save-sql-input csv-fixed-w mono"
            type="number"
            min={1}
            value={kind.at + 1}
            onChange={(e) =>
              onChange({ at: Math.max(0, (+e.target.value || 1) - 1) })
            }
          />
          <span>{UNIT_LABEL[unit]}目から</span>
          <input
            className="save-sql-input csv-fixed-w mono"
            type="number"
            min={1}
            value={kind.len}
            onChange={(e) => onChange({ len: Math.max(1, +e.target.value || 1) })}
          />
          <span>{UNIT_LABEL[unit]}が</span>
          <input
            className="save-sql-input csv-kind-value mono"
            placeholder="例: A"
            value={kind.value}
            onChange={(e) => onChange({ value: e.target.value })}
          />
          <span>のとき</span>
        </div>
      </div>
    </div>
  );
}
