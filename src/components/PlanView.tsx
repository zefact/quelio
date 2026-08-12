import { useMemo, useRef, useState } from "react";
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

/** 行数の表示 (常にカンマ区切り) */
function fmtRows(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** ループ回数の表示 (1億未満はカンマ区切り、1億以上のみ指数表示) */
function fmtLoops(n: number): string {
  return n >= 1e8
    ? n.toExponential(1).replace("e+", "e")
    : Math.round(n).toLocaleString("en-US");
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
  bar: "その処理が単体で使った時間の比較バー (子ノードの時間は含みません)。一番遅い処理を最大として表示し、長く赤いバーほど改善効果が大きい箇所です",
} as const;

/** きれいなツリー表示 */
function PrettyPlan({ nodes }: { nodes: PlanNode[] }) {
  const totalMs = Math.max(
    ...nodes.map((n) => n.inclusiveMs ?? 0),
    0.000001
  );
  const maxSelf = Math.max(...nodes.map((n) => n.selfMs ?? 0));
  const hasActual = nodes.some((n) => n.inclusiveMs !== undefined);

  // 折りたたまれたノード (indexの集合)。折りたたみ中は配下のノードを非表示にする
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const toggleCollapse = (i: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) {
        next.delete(i);
      } else {
        next.add(i);
      }
      return next;
    });

  // 折りたたみ中の祖先を持つノードを除いた表示対象のindex一覧
  const visible: number[] = [];
  {
    /** 折りたたみ中ノードの深さ (これより深いノードは非表示) */
    let hideDeeperThan: number | null = null;
    nodes.forEach((n, i) => {
      if (hideDeeperThan !== null) {
        if (n.depth > hideDeeperThan) return;
        hideDeeperThan = null;
      }
      visible.push(i);
      if (collapsed.has(i)) hideDeeperThan = n.depth;
    });
  }

  /** 配下 (子孫) のノード数 */
  const descendantCount = (i: number): number => {
    let count = 0;
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[j].depth <= nodes[i].depth) break;
      count++;
    }
    return count;
  };

  // 操作カラムの幅 (null = 自動。ヘッダのリサイザをドラッグで固定幅にできる)
  const [opWidth, setOpWidth] = useState<number | null>(null);
  const headOpRef = useRef<HTMLSpanElement>(null);

  const startOpResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = opWidth ?? headOpRef.current?.offsetWidth ?? 300;
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    const move = (ev: MouseEvent) =>
      setOpWidth(Math.max(140, startW + ev.clientX - startX));
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.body.style.cursor = prevCursor;
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** 操作カラムの幅指定 (固定時のみ)。
   * 固定幅 (flex: none) にすることでドラッグした幅がそのまま反映される。
   * 列位置のズレはCSS側 (op-fixed時のmargin-left: auto) で右端に揃えて防ぐ */
  const opStyle = (indent = 0): React.CSSProperties | undefined =>
    opWidth !== null
      ? { width: opWidth, flex: "none", paddingLeft: indent }
      : { paddingLeft: indent };

  return (
    <div className={"plan-pretty" + (opWidth !== null ? " op-fixed" : "")}>
      {/* ヘッダと行を同じ幅にするための内側ラッパ (横スクロールの基準) */}
      <div className="plan-inner">
      <div className="plan-sticky">
        {hasActual && (
          <div className="plan-summary">
            <span className="plan-summary-item">
              総実行時間 <strong className="mono">{fmtMs(totalMs)}</strong>
            </span>
            <span className="plan-summary-hint">
              「負荷」は各処理が単体で使った時間の比較です。長く赤いバーの処理がボトルネックです
            </span>
          </div>
        )}
        <div className="plan-head">
          <span
            className="plan-head-op-wrap"
            ref={headOpRef}
            style={opWidth !== null ? { width: opWidth, flex: "none" } : undefined}
          >
            <HoverTip className="plan-head-op" text={PLAN_COL_DESC.op}>
              操作
            </HoverTip>
          </span>
          <span
            className="plan-col-resizer"
            title="ドラッグで操作カラムの幅を変更 / ダブルクリックで自動に戻す"
            onMouseDown={startOpResize}
            onDoubleClick={() => setOpWidth(null)}
          />
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
        {visible.map((i) => {
          const n = nodes[i];
          const selfRatio = maxSelf > 0 ? (n.selfMs ?? 0) / maxSelf : 0;
          const hot = selfRatio > 0.66;
          const warm = selfRatio > 0.33 && !hot;
          const gap = estimateGap(n);
          const hasChildren =
            i + 1 < nodes.length && nodes[i + 1].depth > n.depth;
          const isCollapsed = collapsed.has(i);
          return (
            <div className={"plan-row" + (hot ? " hot" : "")} key={i}>
              <div className="plan-row-main" style={opStyle(n.depth * 18)}>
                <span className="plan-tree-mark" aria-hidden>
                  {n.depth > 0 ? "└" : ""}
                </span>
                {hasChildren ? (
                  <button
                    className="plan-toggle"
                    title={isCollapsed ? "配下を展開" : "配下を折りたたむ"}
                    onClick={() => toggleCollapse(i)}
                  >
                    {isCollapsed ? "▸" : "▾"}
                  </button>
                ) : (
                  <span className="plan-toggle spacer" aria-hidden />
                )}
                <span
                  className="plan-op"
                  title={n.detail ? `${n.op} (${n.detail})` : n.op}
                >
                  {n.op}
                </span>
                {isCollapsed && (
                  <span
                    className="plan-chip dim"
                    title="折りたたみ中の配下ノード数"
                  >
                    +{descendantCount(i)}
                  </span>
                )}
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
                        ×{fmtLoops(n.loops!)}
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
