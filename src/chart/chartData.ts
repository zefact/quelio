/**
 * クエリ結果を簡易チャートにするための下ごしらえ。
 *
 * 集計クエリの結果を「ざっと見て確かめる」ための最小限に絞る。
 * BIツールにはしないので、集計はせず、結果の行をそのまま点にする。
 * 描画に依存しない計算だけを置き、SVGとPNGの両方から使う
 */

/** 描けるグラフの種類 */
export type ChartKind = "bar" | "line" | "pie";

/** グラフの1点 */
export interface ChartPoint {
  label: string;
  value: number;
}

/** 棒・折れ線で一度に描く点の上限 (多すぎると読めない) */
export const MAX_POINTS = 60;
/** 円グラフの扇の上限 (これを超えたぶんは「その他」へまとめる) */
export const MAX_SLICES = 6;

/**
 * 数値として読める値なら数値にする。
 *
 * 桁区切りのカンマと通貨記号、末尾の空白は許す。
 * 日付や真偽値は数値にしない (グラフの値としては意味が違う)
 */
export function toNumber(v: string | null): number | null {
  if (v === null) return null;
  const t = v.trim().replace(/,/g, "").replace(/^[¥$€£]/, "");
  if (t === "" || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 数値が過半数を占める列 (値の列の候補) */
export function numericColumns(
  columns: string[],
  rows: (string | null)[][]
): number[] {
  const look = rows.slice(0, 200);
  const out: number[] = [];
  for (let c = 0; c < columns.length; c++) {
    let num = 0;
    let seen = 0;
    for (const r of look) {
      const v = r[c];
      if (v === null || v === undefined || v === "") continue;
      seen++;
      if (toNumber(v) !== null) num++;
    }
    if (seen > 0 && num * 2 > seen) out.push(c);
  }
  return out;
}

/** 最初に選んでおく列 (ラベルは数値でない列、値は数値の列) */
export function defaultColumns(
  columns: string[],
  rows: (string | null)[][]
): { labelCol: number; valueCol: number } | null {
  if (columns.length === 0) return null;
  const nums = numericColumns(columns, rows);
  if (nums.length === 0) return null;
  const valueCol = nums[nums.length - 1];
  const label = columns.findIndex((_, i) => !nums.includes(i));
  return { labelCol: label >= 0 ? label : 0, valueCol };
}

export interface ChartData {
  points: ChartPoint[];
  /** 値として読めた行の数 (切り詰める前) */
  total: number;
  /** 描けなかった行の数 (値が数値でない) */
  skipped: number;
  /** 多すぎて描かなかった点の数 */
  omitted: number;
  /** 円グラフで「その他」にまとめた件数 */
  otherCount: number;
  /** 縦軸の目盛 (棒・折れ線のみ) */
  ticks: number[];
  min: number;
  max: number;
}

/** 目盛の間隔に使う「切りの良い」数字 */
const LADDER = [1, 2, 2.5, 5, 10];

/** 目盛を切りの良い数字にする */
export function niceTicks(min: number, max: number, want = 4): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (lo === hi) return [0, 1];
  const raw = (hi - lo) / want;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  // 1 / 2 / 2.5 / 5 / 10 のうち、必要な間隔を満たす一番細かいもの
  const step = (LADDER.find((v) => norm <= v) ?? 10) * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const out: number[] = [];
  // 浮動小数の誤差で目盛が1本増えないよう、桁をそろえてから比べる
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  for (let v = start; v <= end + step / 2; v += step) {
    out.push(Number(v.toFixed(digits)));
  }
  return out;
}

/** 結果の行からグラフのデータを作る */
export function buildChart(
  rows: (string | null)[][],
  labelCol: number,
  valueCol: number,
  kind: ChartKind
): ChartData {
  const points: ChartPoint[] = [];
  let skipped = 0;
  for (const r of rows) {
    const n = toNumber(r[valueCol] ?? null);
    if (n === null) {
      skipped++;
      continue;
    }
    const raw = r[labelCol];
    points.push({ label: raw === null ? "NULL" : raw, value: n });
  }
  const total = points.length;

  if (kind === "pie") {
    // 割合を見るものなので、負の値は扱わない
    const positive = points.filter((p) => p.value > 0);
    skipped += points.length - positive.length;
    const sorted = [...positive].sort((a, b) => b.value - a.value);
    const head = sorted.slice(0, MAX_SLICES);
    const tail = sorted.slice(MAX_SLICES);
    if (tail.length > 0) {
      head.push({
        label: `その他 (${tail.length}件)`,
        value: tail.reduce((s, p) => s + p.value, 0),
      });
    }
    return {
      points: head,
      total: positive.length,
      skipped,
      omitted: 0,
      otherCount: tail.length,
      ticks: [],
      min: 0,
      max: head.reduce((s, p) => s + p.value, 0),
    };
  }

  const shown = points.slice(0, MAX_POINTS);
  const values = shown.map((p) => p.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  return {
    points: shown,
    total,
    skipped,
    omitted: Math.max(0, total - shown.length),
    otherCount: 0,
    ticks: niceTicks(min, max),
    min,
    max,
  };
}
