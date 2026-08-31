/**
 * クエリ結果の簡易チャート (モーダル)。
 *
 * 集計クエリを流したあと「だいたい合っているか」を目で確かめるためのもの。
 * BIツールにはしないので、集計はせず、出ている結果をそのまま描く
 */
import { useMemo, useState } from "react";
import { useModal } from "../hooks/useModal";
import { SelectMenu } from "./SelectMenu";
import { ChartView } from "./ChartView";
import {
  buildChart,
  defaultColumns,
  numericColumns,
  type ChartKind,
} from "../chart/chartData";
import { fmtValue, sliceGeoms, type ChartBox } from "../chart/chartGeom";

interface Props {
  columns: string[];
  rows: (string | null)[][];
  onClose: () => void;
}

const KINDS: [ChartKind, string][] = [
  ["bar", "棒"],
  ["line", "折れ線"],
  ["pie", "円"],
];

/** グラフの大きさ (画面の広さに合わせて決め打ちする) */
const BOX: ChartBox = { w: 720, h: 320, left: 62, right: 14, top: 12, bottom: 30 };
const PIE_BOX: ChartBox = { w: 320, h: 320, left: 0, right: 0, top: 0, bottom: 0 };

export function ResultChart({ columns, rows, onClose }: Props) {
  const boxRef = useModal(onClose);
  const [kind, setKind] = useState<ChartKind>("bar");
  const nums = useMemo(() => numericColumns(columns, rows), [columns, rows]);
  const initial = useMemo(() => defaultColumns(columns, rows), [columns, rows]);
  const [labelCol, setLabelCol] = useState(initial?.labelCol ?? 0);
  const [valueCol, setValueCol] = useState(initial?.valueCol ?? 0);

  const data = useMemo(
    () => buildChart(rows, labelCol, valueCol, kind),
    [rows, labelCol, valueCol, kind]
  );
  const sum = data.points.reduce((s, p) => s + p.value, 0);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal chart-modal viz-root"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            グラフ
            <span className="column-modal-target mono">
              {columns[valueCol] ?? ""} / {columns[labelCol] ?? ""}
            </span>
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        <div className="chart-controls">
          <div className="chart-kinds">
            {KINDS.map(([k, label]) => (
              <button
                key={k}
                className={kind === k ? "on" : ""}
                onClick={() => setKind(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="chart-pick">
            ラベル
            <SelectMenu
              className="mono"
              value={String(labelCol)}
              options={columns.map((c, i) => ({ value: String(i), label: c }))}
              onChange={(v) => setLabelCol(Number(v))}
            />
          </label>
          <label className="chart-pick">
            値
            <SelectMenu
              className="mono"
              value={String(valueCol)}
              options={columns.map((c, i) => ({
                value: String(i),
                label: nums.includes(i) ? c : `${c} (数値でない列)`,
              }))}
              onChange={(v) => setValueCol(Number(v))}
            />
          </label>
        </div>

        {data.points.length === 0 ? (
          <div className="content-placeholder dim-center chart-empty">
            この列には数値がありません。値の列を選び直してください
          </div>
        ) : (
          <div className={"chart-body" + (kind === "pie" ? " pie" : "")}>
            <ChartView
              data={data}
              kind={kind}
              valueLabel={columns[valueCol] ?? ""}
              box={kind === "pie" ? PIE_BOX : BOX}
            />
            {/* 円は色だけで見分けさせない (凡例に名前と値を並べる) */}
            {kind === "pie" && (
              <ul className="chart-legend">
                {sliceGeoms(data).map((s) => (
                  <li key={s.index}>
                    <span className={`chart-swatch s${(s.index % 8) + 1}`} aria-hidden />
                    <span className="chart-legend-name">{s.point.label}</span>
                    <span className="chart-legend-value mono">
                      {fmtValue(s.point.value)}
                      <span className="chart-legend-pct">
                        {((s.point.value / (sum || 1)) * 100).toFixed(1)}%
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="chart-note">
          {data.points.length.toLocaleString()}件を表示
          {data.omitted > 0 && ` (先頭のみ。残り${data.omitted.toLocaleString()}件は省略)`}
          {data.otherCount > 0 && ` ・ 小さい${data.otherCount}件は「その他」にまとめました`}
          {data.skipped > 0 && ` ・ 値が数値でない${data.skipped.toLocaleString()}行は除きました`}
        </div>

        <div className="modal-actions">
          <span className="toolbar-spacer" />
          <button className="btn-primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
