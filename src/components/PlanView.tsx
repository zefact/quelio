import { useMemo, useState } from "react";
import { HoverTip } from "./HoverTip";

/**
 * EXPLAIN / EXPLAIN ANALYZE の実行計画ビュー。
 * MySQL(ツリー形式)とPostgreSQLのテキストをパースし、
 * 所要時間バー・行数・予測乖離の警告つきで表示する。
 * パースできない形式は生テキスト表示にフォールバックする。
 */

interface Props {
  lines: string[];
}

interface PlanNode {
  depth: number;
  /** 操作名 (Nested loop inner join など) */
  op: string;
  /** 条件・対象などの補足 (Filterの条件式など) */
  detail: string;
  cost?: number;
  estRows?: number;
  timeLast?: number;
  actRows?: number;
  loops?: number;
  neverExecuted?: boolean;
  /** timeLast × loops (このノード以下の合計時間) */
  inclusiveMs?: number;
  /** inclusiveMs - 子の合計 (このノード自身の時間) */
  selfMs?: number;
}

const NUM = String.raw`[0-9.]+(?:e[+-]?[0-9]+)?`;
const COST_RE = new RegExp(`\\(cost=(${NUM})(?:\\.\\.(?:${NUM}))? rows=(${NUM})(?: width=\\d+)?\\)`);
const ACTUAL_RE = new RegExp(
  `\\(actual time=(${NUM})\\.\\.(${NUM}) rows=(${NUM}) loops=(${NUM})\\)`
);

/** 実行計画テキストをノード配列にパースする (失敗ならnull) */
function parsePlan(lines: string[]): PlanNode[] | null {
  const nodes: PlanNode[] = [];

  for (const raw of lines) {
    if (raw.trim() === "") continue;
    const indent = raw.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = raw.trim();
    const isArrow = trimmed.startsWith("->");
    let body = isArrow ? trimmed.slice(2).trim() : trimmed;

    // メタ情報を取り出す
    const cost = body.match(COST_RE);
    const actual = body.match(ACTUAL_RE);
    const never = body.includes("(never executed)");

    // 名前部分 = 最初の "(cost=" / "(actual" の手前
    let cut = body.length;
    for (const marker of ["(cost=", "(actual time=", "(never executed)"]) {
      const i = body.indexOf(marker);
      if (i >= 0 && i < cut) cut = i;
    }
    const name = body.slice(0, cut).trim();

    if (!isArrow && nodes.length > 0 && !cost && !actual) {
      // "Filter: ..." などの付帯行は直前のノードの補足に足す
      const prev = nodes[nodes.length - 1];
      prev.detail = prev.detail ? `${prev.detail} / ${name}` : name;
      continue;
    }

    // 操作名と補足を分離 ("Filter: (...)" や "Index lookup on t using idx (...)")
    let op = name;
    let detail = "";
    const colon = name.indexOf(": ");
    const paren = name.indexOf(" (");
    if (colon >= 0 && (paren < 0 || colon < paren)) {
      op = name.slice(0, colon);
      detail = name.slice(colon + 2);
    } else if (paren >= 0) {
      op = name.slice(0, paren);
      detail = name.slice(paren + 1);
    }

    const node: PlanNode = {
      depth: Math.floor(indent / 4),
      op,
      detail,
      neverExecuted: never,
    };
    if (cost) {
      node.cost = parseFloat(cost[1]);
      node.estRows = parseFloat(cost[2]);
    }
    if (actual) {
      node.timeLast = parseFloat(actual[2]);
      node.actRows = parseFloat(actual[3]);
      node.loops = parseFloat(actual[4]);
      node.inclusiveMs = node.timeLast * (node.loops || 1);
    }
    nodes.push(node);
  }

  if (nodes.length === 0) return null;
  // ノード行が1つも解析できていなければ諦める
  if (!nodes.some((n) => n.cost !== undefined || n.inclusiveMs !== undefined)) {
    return null;
  }

  // 深さを正規化 (最小深さを0に)
  const minDepth = Math.min(...nodes.map((n) => n.depth));
  nodes.forEach((n) => (n.depth -= minDepth));

  // self時間 = 自分のinclusive - 直下の子のinclusive合計
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.inclusiveMs === undefined) continue;
    let childSum = 0;
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[j].depth <= n.depth) break;
      if (nodes[j].depth === n.depth + 1 && nodes[j].inclusiveMs !== undefined) {
        childSum += nodes[j].inclusiveMs!;
      }
    }
    n.selfMs = Math.max(0, n.inclusiveMs - childSum);
  }
  return nodes;
}

/** ミリ秒の表示 */
function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(1)}ms`;
  return `${ms.toFixed(3)}ms`;
}

function fmtRows(n: number): string {
  return n >= 10000 ? n.toExponential(1).replace("e+", "e") : n.toLocaleString();
}

/** 予測行数と実測行数の乖離倍率 (10倍以上で警告) */
function estimateGap(n: PlanNode): number | null {
  if (n.estRows === undefined || n.actRows === undefined) return null;
  const est = Math.max(n.estRows, 1);
  const act = Math.max(n.actRows, 1);
  const ratio = Math.max(est / act, act / est);
  return ratio >= 10 ? Math.round(ratio) : null;
}

/** ツリー表示のカラムヘッダに出す意味の説明 */
const PLAN_COL_DESC = {
  op: "実行される操作 (結合・スキャン・集計など)。下にあるノードから先に実行されます",
  rows: "このノードが返した行数。EXPLAIN ANALYZEでは実測値、EXPLAINのみの場合は予測値",
  loops: "このノードが繰り返し実行された回数。時間は1回あたりの時間×回数で合算しています",
  time: "このノード以下 (子ノードを含む) にかかった合計時間",
  bar: "ノード自身の処理時間が全体に占める割合。バーが長く赤いほど遅い箇所です",
} as const;

/** きれいなツリー表示 */
function PrettyPlan({ nodes }: { nodes: PlanNode[] }) {
  const totalMs = Math.max(
    ...nodes.map((n) => n.inclusiveMs ?? 0),
    0.000001
  );
  const maxSelf = Math.max(...nodes.map((n) => n.selfMs ?? 0));
  const hasActual = nodes.some((n) => n.inclusiveMs !== undefined);

  return (
    <div className="plan-pretty">
      <div className="plan-sticky">
        {hasActual && (
          <div className="plan-summary">
            <span className="plan-summary-item">
              総実行時間 <strong className="mono">{fmtMs(totalMs)}</strong>
            </span>
            <span className="plan-summary-hint">
              ■ の長さ = そのノード自身にかかった時間の割合。赤いほど遅い箇所です
            </span>
          </div>
        )}
        <div className="plan-head">
          <HoverTip className="plan-head-op" text={PLAN_COL_DESC.op}>
            操作
          </HoverTip>
          <HoverTip className="plan-col rows" text={PLAN_COL_DESC.rows}>
            行数
          </HoverTip>
          {hasActual && (
            <HoverTip className="plan-col loops" text={PLAN_COL_DESC.loops}>
              ループ
            </HoverTip>
          )}
          {hasActual && (
            <HoverTip className="plan-col time" text={PLAN_COL_DESC.time}>
              時間
            </HoverTip>
          )}
          {hasActual && (
            <HoverTip className="plan-col bar" text={PLAN_COL_DESC.bar}>
              負荷
            </HoverTip>
          )}
        </div>
      </div>
      <div className="plan-tree">
        {nodes.map((n, i) => {
          const selfRatio = maxSelf > 0 ? (n.selfMs ?? 0) / maxSelf : 0;
          const hot = selfRatio > 0.66;
          const warm = selfRatio > 0.33 && !hot;
          const gap = estimateGap(n);
          return (
            <div
              className={"plan-row" + (hot ? " hot" : "")}
              key={i}
              style={{ paddingLeft: 10 + n.depth * 18 }}
            >
              <div className="plan-row-main">
                <span className="plan-tree-mark" aria-hidden>
                  {n.depth > 0 ? "└" : ""}
                </span>
                <span
                  className="plan-op"
                  title={n.detail ? `${n.op} (${n.detail})` : n.op}
                >
                  {n.op}
                </span>
                {n.detail && (
                  <span className="plan-detail mono" title={n.detail}>
                    {n.detail}
                  </span>
                )}
              </div>
              <div className="plan-row-metrics mono">
                {gap !== null && (
                  <span
                    className="plan-badge warn"
                    title={`行数の予測(${fmtRows(n.estRows!)})と実測(${fmtRows(
                      n.actRows!
                    )})が約${gap}倍ずれています。統計情報が古い可能性`}
                  >
                    予測乖離
                  </span>
                )}
                {n.neverExecuted && (
                  <span className="plan-badge dim">未実行</span>
                )}
                <span className="plan-col rows">
                  {n.actRows !== undefined ? (
                    <span
                      className="plan-chip"
                      title={
                        n.estRows !== undefined
                          ? `実測${fmtRows(n.actRows)}行 (予測${fmtRows(n.estRows)}行)`
                          : "実測行数"
                      }
                    >
                      {fmtRows(n.actRows)}行
                    </span>
                  ) : n.estRows !== undefined ? (
                    <span className="plan-chip" title="予測行数">
                      予測{fmtRows(n.estRows)}行
                    </span>
                  ) : null}
                </span>
                {hasActual && (
                  <span className="plan-col loops">
                    {(n.loops ?? 1) > 1 && (
                      <span className="plan-chip" title="繰り返し回数">
                        ×{fmtRows(n.loops!)}
                      </span>
                    )}
                  </span>
                )}
                {hasActual && (
                  <span
                    className={
                      "plan-col time plan-time" +
                      (hot ? " hot" : warm ? " warm" : "")
                    }
                    title={
                      n.inclusiveMs !== undefined
                        ? `このノード以下の合計時間 (自身: ${fmtMs(n.selfMs ?? 0)})`
                        : undefined
                    }
                  >
                    {n.inclusiveMs !== undefined ? fmtMs(n.inclusiveMs) : ""}
                  </span>
                )}
                {hasActual && (
                  <span className="plan-col bar plan-bar" aria-hidden>
                    <span
                      className={
                        "plan-bar-fill" + (hot ? " hot" : warm ? " warm" : "")
                      }
                      style={{ width: `${Math.max(2, selfRatio * 100)}%` }}
                    />
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 実行計画の表示本体 (ツリー/テキスト切替) */
export function PlanView({ lines }: Props) {
  const nodes = useMemo(() => parsePlan(lines), [lines]);
  const [rawMode, setRawMode] = useState(false);
  const pretty = nodes !== null && !rawMode;

  return (
    <div className="plan-container">
      {nodes !== null && (
        <div className="plan-toolbar">
          <div className="result-tabs plan-mode-tabs">
            <button
              className={"result-tab" + (pretty ? " active" : "")}
              onClick={() => setRawMode(false)}
            >
              ツリー表示
            </button>
            <button
              className={"result-tab" + (!pretty ? " active" : "")}
              onClick={() => setRawMode(true)}
            >
              テキスト
            </button>
          </div>
        </div>
      )}
      {pretty ? (
        <PrettyPlan nodes={nodes!} />
      ) : (
        <div className="plan-view mono">
          {lines.map((line, i) => (
            <div className="plan-line" key={i}>
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 結果が実行計画かどうか (単一カラムのEXPLAIN/QUERY PLAN) */
export function isPlanResult(columns: string[]): boolean {
  return (
    columns.length === 1 &&
    ["EXPLAIN", "QUERY PLAN"].includes(columns[0].toUpperCase())
  );
}

/** 結果行を計画テキストの行配列へ正規化 (セル内改行も展開) */
export function planLines(rows: (string | null)[][]): string[] {
  return rows.flatMap((r) => (r[0] ?? "").split("\n"));
}
