/**
 * 簡易チャートの描画 (SVG)。
 *
 * 集計クエリの結果を確かめるための小さなグラフ。
 * 線は細く、目盛は控えめにして、データだけが目立つようにする。
 * 色はCSS変数で持ち、ライト/ダークで別の値に差し替える
 */
import { useState } from "react";
import type { ChartData, ChartKind } from "../chart/chartData";
import {
  barGeoms,
  barPath,
  DOT_R,
  fmtValue,
  lineGeoms,
  sliceGeoms,
  slicePath,
  type ChartBox,
} from "../chart/chartGeom";

interface Props {
  data: ChartData;
  kind: ChartKind;
  /** 縦軸に出す見出し (値の列名) */
  valueLabel: string;
  box: ChartBox;
}

/** 触れている点の説明 (ツールチップ) */
interface Hover {
  x: number;
  y: number;
  label: string;
  value: string;
}

/** ラベルが長いときに詰める (軸に置ける幅は限られる) */
function short(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function ChartView({ data, kind, valueLabel, box }: Props) {
  const [hover, setHover] = useState<Hover | null>(null);
  const plotX = box.left;
  const plotW = box.w - box.left - box.right;
  const plotBottom = box.h - box.bottom;

  /** 軸ラベルは全部は置けないので、間引いて出す */
  const labelEvery = Math.ceil(data.points.length / Math.max(1, Math.floor(plotW / 70)));

  const grid = (
    <g className="chart-grid">
      {data.ticks.map((t, i) => {
        const y =
          plotBottom -
          ((t - data.ticks[0]) / (data.ticks[data.ticks.length - 1] - data.ticks[0] || 1)) *
            (plotBottom - box.top);
        return (
          <g key={i}>
            <line x1={plotX} x2={plotX + plotW} y1={y} y2={y} />
            <text className="chart-tick" x={plotX - 6} y={y + 3.5} textAnchor="end">
              {fmtValue(t)}
            </text>
          </g>
        );
      })}
    </g>
  );

  const body = () => {
    if (kind === "pie") {
      const cx = box.w / 2;
      const cy = box.h / 2;
      const r = Math.max(10, Math.min(box.w, box.h) / 2 - 12);
      const sum = data.points.reduce((s, p) => s + p.value, 0) || 1;
      return (
        <g>
          {sliceGeoms(data).map((s) => (
            <path
              key={s.index}
              className={`chart-slice s${(s.index % 8) + 1}`}
              d={slicePath(s, cx, cy, r)}
              onMouseEnter={(e) =>
                setHover({
                  x: e.nativeEvent.offsetX,
                  y: e.nativeEvent.offsetY,
                  label: s.point.label,
                  value: `${fmtValue(s.point.value)} (${((s.point.value / sum) * 100).toFixed(1)}%)`,
                })
              }
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </g>
      );
    }

    if (kind === "line") {
      const pts = lineGeoms(data, box);
      const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
      return (
        <g>
          <path className="chart-line" d={d} />
          {pts.map((p) => (
            <circle key={p.index} className="chart-dot" cx={p.x} cy={p.y} r={DOT_R} />
          ))}
          {pts.map((p) => (
            <rect
              key={`h${p.index}`}
              className="chart-hit"
              x={p.bandX}
              y={box.top}
              width={p.bandW}
              height={plotBottom - box.top}
              onMouseEnter={() =>
                setHover({
                  x: p.x,
                  y: p.y,
                  label: p.point.label,
                  value: fmtValue(p.point.value),
                })
              }
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </g>
      );
    }

    const bars = barGeoms(data, box);
    return (
      <g>
        {bars.map((b) => (
          <path key={b.index} className="chart-bar" d={barPath(b)} />
        ))}
        {bars.map((b) => (
          <rect
            key={`h${b.index}`}
            className="chart-hit"
            x={b.bandX}
            y={box.top}
            width={b.bandW}
            height={plotBottom - box.top}
            onMouseEnter={() =>
              setHover({
                x: b.x + b.w / 2,
                y: b.y,
                label: b.point.label,
                value: fmtValue(b.point.value),
              })
            }
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </g>
    );
  };

  /** 横軸のラベル (間引いて出す) */
  const axisLabels = () => {
    if (kind === "pie") return null;
    const geoms =
      kind === "line"
        ? lineGeoms(data, box).map((p) => ({ x: p.x, label: p.point.label }))
        : barGeoms(data, box).map((b) => ({
            x: b.x + b.w / 2,
            label: b.point.label,
          }));
    return (
      <g>
        {geoms.map((g, i) =>
          i % labelEvery === 0 ? (
            <text
              key={i}
              className="chart-axis-label"
              x={g.x}
              y={plotBottom + 15}
              textAnchor="middle"
            >
              {short(g.label, 10)}
            </text>
          ) : null
        )}
      </g>
    );
  };

  return (
    <div className="chart-canvas">
      <svg
        className="chart-svg"
        width={box.w}
        height={box.h}
        viewBox={`0 0 ${box.w} ${box.h}`}
        role="img"
        aria-label={`${valueLabel} のグラフ`}
      >
        {kind !== "pie" && grid}
        {body()}
        {axisLabels()}
        {kind !== "pie" && (
          <line
            className="chart-baseline"
            x1={plotX}
            x2={plotX + plotW}
            y1={plotBottom}
            y2={plotBottom}
          />
        )}
      </svg>
      {hover && (
        <div
          className="chart-tip"
          style={{ left: hover.x, top: Math.max(0, hover.y - 8) }}
        >
          <span className="chart-tip-label">{hover.label}</span>
          <span className="chart-tip-value mono">{hover.value}</span>
        </div>
      )}
    </div>
  );
}
