import type { ColumnInfo, CsvPreview } from "../../types";

/** 空文字は「取り込まない」を表す (selectの値にnullは置けないため) */
const SKIP = "";

interface Props {
  preview: CsvPreview;
  /** 取り込み先テーブルの列 */
  targets: ColumnInfo[];
  /** CSVの列ごとの取り込み先 (nullなら取り込まない) */
  mapping: (string | null)[];
  onChange: (index: number, target: string | null) => void;
  disabled: boolean;
}

/** CSVの列と取り込み先の対応、および先頭数行の中身 */
export function CsvMapping({
  preview,
  targets,
  mapping,
  onChange,
  disabled,
}: Props) {
  /* 2か所以上で選ばれている取り込み先 (見て分かるよう色を変える) */
  const dup = new Set<string>();
  const seen = new Set<string>();
  for (const m of mapping) {
    if (m === null) continue;
    if (seen.has(m)) dup.add(m);
    seen.add(m);
  }

  return (
    <div className="csv-map">
      <table className="csv-map-table">
        <thead>
          <tr>
            {preview.columns.map((name, i) => {
              const target = mapping[i] ?? null;
              return (
              <th key={i}>
                <span className="csv-map-name mono" title={name}>
                  {name}
                </span>
                <select
                  className={
                    "csv-map-select" +
                    (target === null ? " skip" : "") +
                    (target !== null && dup.has(target) ? " dup" : "")
                  }
                  aria-label={`${name} の取り込み先`}
                  value={target ?? SKIP}
                  disabled={disabled}
                  onChange={(e) => onChange(i, e.target.value || null)}
                >
                  <option value={SKIP}>取り込まない</option>
                  {targets.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name} ({c.colType})
                    </option>
                  ))}
                </select>
              </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, ri) => (
            <tr key={ri}>
              {preview.columns.map((_, ci) => (
                <td
                  key={ci}
                  className={
                    (mapping[ci] ?? null) === null ? "csv-map-skip" : undefined
                  }
                  /* 列が足りない行は空欄と区別が付かないので、印を残す */
                  title={ci >= row.length ? "この行にはこの列がありません" : undefined}
                >
                  <span className="mono">
                    {ci < row.length ? row[ci] : "—"}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {preview.rows.length === 0 && (
        <div className="routine-empty">取り込めるデータ行がありません</div>
      )}
    </div>
  );
}
