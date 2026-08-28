import { saveCapture } from "./api";
import {
  fmtLoops,
  fmtMs,
  fmtRows,
  isPlanResult,
  parsePlan,
  planLines,
} from "./components/PlanView";
import type { StatementResult } from "./types";

/**
 * SQL実行結果のキャプチャ(PNG)生成。
 * WKWebViewではhtml-to-image等のSVG経由の画像化が不安定なため、
 * 結果データからCanvasに直接描画してPNG化する。
 */

/** キャプチャ画像の最大辺 (WebKitのcanvas上限より安全側に) */
const MAX_SIDE = 16000;
/** セルの最大表示幅(px)。超える場合は折り返す */
const MAX_CELL_W = 480;
/** 1セルの最大表示行数。超える分は省略する */
const MAX_CELL_LINES = 30;
/** キャプチャ全体の最小コンテンツ幅 */
const MIN_CONTENT_W = 560;

const FONT_MONO = '12px "SF Mono", "Menlo", "Consolas", monospace';
const FONT_MONO_SMALL = '11px "SF Mono", "Menlo", "Consolas", monospace';
const FONT_BRAND = 'bold 14px -apple-system, "Hiragino Sans", sans-serif';

const COLOR = {
  bg: "#0c0e14",
  text: "#e7eaf2",
  dim: "#8b93a8",
  faint: "#5b6275",
  brand: "#a5b4fc",
  border: "rgba(255, 255, 255, 0.14)",
  gridLine: "rgba(255, 255, 255, 0.12)",
  headBg: "rgba(255, 255, 255, 0.06)",
  sqlBg: "rgba(255, 255, 255, 0.045)",
  rowAlt: "rgba(255, 255, 255, 0.02)",
};

const LINE_H = 18;
const CELL_PAD_X = 9;
const CELL_PAD_Y = 4;
const MARGIN = 22;

/** 文字幅キャッシュつきの計測器 */
class Measurer {
  private cache = new Map<string, number>();
  constructor(
    private ctx: CanvasRenderingContext2D,
    private font: string
  ) {}

  charW(ch: string): number {
    let w = this.cache.get(ch);
    if (w === undefined) {
      this.ctx.font = this.font;
      w = this.ctx.measureText(ch).width;
      this.cache.set(ch, w);
    }
    return w;
  }

  textW(text: string): number {
    let w = 0;
    for (const ch of text) w += this.charW(ch);
    return w;
  }

  /** maxWで折り返した行の配列を返す (改行も考慮) */
  wrap(text: string, maxW: number): string[] {
    const out: string[] = [];
    for (const raw of text.split("\n")) {
      if (raw === "") {
        out.push("");
        continue;
      }
      let line = "";
      let w = 0;
      for (const ch of raw) {
        const cw = this.charW(ch);
        if (w + cw > maxW && line !== "") {
          out.push(line);
          line = ch;
          w = cw;
        } else {
          line += ch;
          w += cw;
        }
      }
      if (line !== "") out.push(line);
    }
    return out;
  }
}

/** 結果メタ情報のラベル (行数・時間) */
function metaLabel(s: StatementResult): string {
  const r = s.result;
  if (r.rowsAffected !== null && r.rowsAffected !== undefined) {
    return `${r.rowsAffected}行に影響 — ${r.elapsedMs}ms`;
  }
  if (r.rows.length === 0) return `0行 — ${r.elapsedMs}ms`;
  if (r.pageable) {
    const from = r.offset + 1;
    const to = r.offset + r.rows.length;
    return `${from.toLocaleString()}〜${to.toLocaleString()}行目${
      r.hasMore ? " (続きあり)" : ""
    } — ${r.elapsedMs}ms`;
  }
  return `${r.rows.length}行${r.hasMore ? " (先頭のみ)" : ""} — ${r.elapsedMs}ms`;
}

interface CellLayout {
  lines: string[];
  isNull: boolean;
}

/** テキストをmaxWに収まるよう末尾を「…」で切り詰める */
function truncateText(m: Measurer, text: string, maxW: number): string {
  if (m.textW(text) <= maxW) return text;
  let out = "";
  let w = 0;
  const ellW = m.charW("…");
  for (const ch of text) {
    const cw = m.charW(ch);
    if (w + cw + ellW > maxW) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** キャプチャ共通のヘッダ (ブランド/タブ番号/日時) とSQLボックスを描画してy位置を返す */
function drawHeaderAndSql(
  ctx: CanvasRenderingContext2D,
  sqlLines: string[],
  index: number,
  total: number,
  width: number,
  contentW: number
): number {
  const headH = 26;
  const sqlH = sqlLines.length * LINE_H + 20;
  let y = MARGIN;

  ctx.font = FONT_BRAND;
  ctx.fillStyle = COLOR.brand;
  ctx.fillText("Quelio", MARGIN, y + headH / 2 - 4);
  if (total > 1) {
    ctx.font = FONT_MONO_SMALL;
    ctx.fillStyle = COLOR.dim;
    ctx.fillText(`${index + 1}/${total}`, MARGIN + 62, y + headH / 2 - 4);
  }
  {
    const ts = new Date().toLocaleString("ja-JP");
    ctx.font = FONT_MONO_SMALL;
    ctx.fillStyle = COLOR.faint;
    const w = ctx.measureText(ts).width;
    ctx.fillText(ts, width - MARGIN - w, y + headH / 2 - 4);
  }
  y += headH;

  ctx.fillStyle = COLOR.sqlBg;
  ctx.strokeStyle = COLOR.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(MARGIN, y, contentW, sqlH, 8);
  } else {
    ctx.rect(MARGIN, y, contentW, sqlH);
  }
  ctx.fill();
  ctx.stroke();
  ctx.font = FONT_MONO;
  ctx.fillStyle = COLOR.text;
  sqlLines.forEach((line, i) => {
    ctx.fillText(line, MARGIN + 12, y + 10 + i * LINE_H + LINE_H / 2);
  });
  return y + sqlH + 8;
}

/** 実行計画の負荷バー・時間の色分け */
const PLAN_COLOR = {
  bar: "#34d399",
  warm: "#fbbf24",
  hot: "#f87171",
  barBg: "rgba(255, 255, 255, 0.08)",
};

/**
 * EXPLAIN / EXPLAIN ANALYZE の結果をアプリのツリー表示と同じ形式で描画する。
 * 通常のセル描画と違い、行数上限は設けない (すべてのノードを出力する)
 */
function renderPlanSheet(
  s: StatementResult,
  index: number,
  total: number
): string {
  const work = document.createElement("canvas");
  const wctx = work.getContext("2d");
  if (!wctx) throw new Error("canvasを初期化できません");
  const mono = new Measurer(wctx, FONT_MONO);
  const small = new Measurer(wctx, FONT_MONO_SMALL);

  const r = s.result;
  const lines = planLines(r.rows);
  const nodes = parsePlan(lines);

  // パースできない形式は生テキストを省略なしで描画する
  if (nodes === null) {
    const contentW = Math.max(
      MIN_CONTENT_W,
      Math.min(1400, Math.max(...lines.map((l) => mono.textW(l))) + 24)
    );
    const sqlLines = mono.wrap(s.sql.trim(), contentW - 24);
    const headH = 26;
    const sqlH = sqlLines.length * LINE_H + 20;
    const textH = lines.length * LINE_H + 12;
    const width = contentW + MARGIN * 2;
    const height = MARGIN + headH + sqlH + 8 + textH + MARGIN;

    const scale = Math.min(2, MAX_SIDE / Math.max(width, height));
    if (scale <= 0.05) throw new Error("結果が大きすぎて画像化できません");
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvasを初期化できません");
    ctx.scale(scale, scale);
    ctx.textBaseline = "middle";
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, width, height);

    const y = drawHeaderAndSql(ctx, sqlLines, index, total, width, contentW);
    ctx.font = FONT_MONO;
    lines.forEach((line, i) => {
      ctx.fillStyle = COLOR.text;
      ctx.fillText(line, MARGIN, y + 6 + i * LINE_H + LINE_H / 2);
    });
    return canvas.toDataURL("image/png");
  }

  // ---- ツリー形式のレイアウト計算 ----
  const hasActual = nodes.some((n) => n.inclusiveMs !== undefined);
  const totalMs = Math.max(...nodes.map((n) => n.inclusiveMs ?? 0), 0.000001);
  const maxSelf = Math.max(...nodes.map((n) => n.selfMs ?? 0), 0);

  const INDENT = 16;
  const GAP = 16;
  const BAR_W = 120;
  const DETAIL_MAX_W = 380;

  const rowsLabels = nodes.map((n) =>
    n.actRows !== undefined
      ? `${fmtRows(n.actRows)}行`
      : n.estRows !== undefined
        ? `予測${fmtRows(n.estRows)}行`
        : ""
  );
  const loopLabels = nodes.map((n) =>
    (n.loops ?? 1) > 1 ? `×${fmtLoops(n.loops!)}` : ""
  );
  const timeLabels = nodes.map((n) =>
    n.inclusiveMs !== undefined ? fmtMs(n.inclusiveMs) : ""
  );

  let opColW = 220;
  for (const n of nodes) {
    const w =
      n.depth * INDENT +
      (n.depth > 0 ? mono.textW("└ ") : 0) +
      mono.textW(n.op) +
      (n.detail ? 8 + Math.min(small.textW(n.detail), DETAIL_MAX_W) : 0);
    if (w > opColW) opColW = w;
  }
  opColW = Math.min(opColW, 760) + 8;

  const rowsW = Math.max(60, ...rowsLabels.map((t) => mono.textW(t)));
  const loopsW = Math.max(0, ...loopLabels.map((t) => mono.textW(t)));
  const timeW = hasActual ? Math.max(56, ...timeLabels.map((t) => mono.textW(t))) : 0;

  const cols =
    opColW +
    GAP +
    rowsW +
    (loopsW > 0 ? GAP + loopsW : 0) +
    (hasActual ? GAP + timeW + GAP + BAR_W : 0);
  const contentW = Math.max(MIN_CONTENT_W, cols);
  const sqlLines = mono.wrap(s.sql.trim(), contentW - 24);

  const headH = 26;
  const sqlH = sqlLines.length * LINE_H + 20;
  const metaH = 24;
  const summaryH = hasActual ? 22 : 0;
  const colHeadH = LINE_H + 6;
  const rowH = LINE_H + 8;
  const treeH = colHeadH + nodes.length * rowH;

  const width = contentW + MARGIN * 2;
  const height =
    MARGIN + headH + sqlH + 8 + metaH + summaryH + treeH + MARGIN;

  const scale = Math.min(2, MAX_SIDE / Math.max(width, height));
  if (scale <= 0.05) throw new Error("結果が大きすぎて画像化できません");

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvasを初期化できません");
  ctx.scale(scale, scale);
  ctx.textBaseline = "middle";
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, width, height);

  let y = drawHeaderAndSql(ctx, sqlLines, index, total, width, contentW);

  // メタ情報 + 総実行時間
  ctx.font = FONT_MONO_SMALL;
  ctx.fillStyle = COLOR.dim;
  ctx.fillText(metaLabel(s), MARGIN, y + metaH / 2 - 2);
  y += metaH;
  if (hasActual) {
    ctx.font = FONT_MONO;
    ctx.fillStyle = COLOR.text;
    ctx.fillText(`総実行時間 ${fmtMs(totalMs)}`, MARGIN, y + summaryH / 2);
    y += summaryH;
  }

  // カラム位置 (右端揃えのx座標)
  const xOpEnd = MARGIN + opColW;
  const xRowsEnd = xOpEnd + GAP + rowsW;
  const xLoopsEnd = loopsW > 0 ? xRowsEnd + GAP + loopsW : xRowsEnd;
  const xTimeEnd = hasActual ? xLoopsEnd + GAP + timeW : xLoopsEnd;
  const xBar = hasActual ? xTimeEnd + GAP : 0;

  // カラムヘッダ
  ctx.font = FONT_MONO_SMALL;
  ctx.fillStyle = COLOR.faint;
  ctx.fillText("操作", MARGIN, y + colHeadH / 2);
  {
    const put = (label: string, xEnd: number) =>
      ctx.fillText(label, xEnd - small.textW(label), y + colHeadH / 2);
    put("行数", xRowsEnd);
    if (loopsW > 0) put("ループ", xLoopsEnd);
    if (hasActual) {
      put("時間", xTimeEnd);
      ctx.fillText("負荷", xBar, y + colHeadH / 2);
    }
  }
  y += colHeadH;

  // ノード行
  nodes.forEach((n, i) => {
    const selfRatio = maxSelf > 0 ? (n.selfMs ?? 0) / maxSelf : 0;
    const hot = selfRatio > 0.66;
    const warm = selfRatio > 0.33 && !hot;

    if (i % 2 === 1) {
      ctx.fillStyle = COLOR.rowAlt;
      ctx.fillRect(MARGIN, y, contentW, rowH);
    }

    // 操作 (インデント + └ + 操作名 + 補足)
    let x = MARGIN + n.depth * INDENT;
    ctx.font = FONT_MONO;
    if (n.depth > 0) {
      ctx.fillStyle = COLOR.faint;
      ctx.fillText("└ ", x, y + rowH / 2);
      x += mono.textW("└ ");
    }
    const opText = truncateText(mono, n.op, xOpEnd - x);
    ctx.fillStyle = hot ? PLAN_COLOR.hot : COLOR.text;
    ctx.fillText(opText, x, y + rowH / 2);
    x += mono.textW(opText);
    if (n.detail && xOpEnd - x > 30) {
      ctx.font = FONT_MONO_SMALL;
      ctx.fillStyle = COLOR.faint;
      ctx.fillText(
        truncateText(small, n.detail, xOpEnd - x - 8),
        x + 8,
        y + rowH / 2
      );
    }

    // 行数 / ループ / 時間 (右揃え)
    ctx.font = FONT_MONO;
    ctx.fillStyle = COLOR.dim;
    const rows = rowsLabels[i];
    if (rows) ctx.fillText(rows, xRowsEnd - mono.textW(rows), y + rowH / 2);
    const loops = loopLabels[i];
    if (loops) ctx.fillText(loops, xLoopsEnd - mono.textW(loops), y + rowH / 2);
    if (hasActual) {
      const time = timeLabels[i];
      ctx.fillStyle = hot
        ? PLAN_COLOR.hot
        : warm
          ? PLAN_COLOR.warm
          : COLOR.text;
      if (time) ctx.fillText(time, xTimeEnd - mono.textW(time), y + rowH / 2);

      // 負荷バー
      const barH = 8;
      const by = y + rowH / 2 - barH / 2;
      ctx.fillStyle = PLAN_COLOR.barBg;
      ctx.fillRect(xBar, by, BAR_W, barH);
      ctx.fillStyle = hot
        ? PLAN_COLOR.hot
        : warm
          ? PLAN_COLOR.warm
          : PLAN_COLOR.bar;
      ctx.fillRect(xBar, by, Math.max(2, selfRatio * BAR_W), barH);
    }
    y += rowH;
  });

  return canvas.toDataURL("image/png");
}

/** 1文ぶんをCanvasに描画してdataURLを返す */
function renderSheet(
  s: StatementResult,
  index: number,
  total: number
): string {
  const r0 = s.result;
  // EXPLAIN / EXPLAIN ANALYZE はツリー表示と同じ形式で省略なしに描画する
  if (r0.columns.length > 0 && isPlanResult(r0.columns) && r0.rows.length > 0) {
    return renderPlanSheet(s, index, total);
  }

  const work = document.createElement("canvas");
  const wctx = work.getContext("2d");
  if (!wctx) throw new Error("canvasを初期化できません");
  const mono = new Measurer(wctx, FONT_MONO);

  const r = s.result;
  const hasTable = r.columns.length > 0 && r.rows.length > 0;

  // ---- レイアウト計算 ----

  // 各カラムの幅 (ヘッダと全セルの最大幅、上限つき)
  const rownumW =
    mono.textW(String(r.offset + r.rows.length)) + CELL_PAD_X * 2;
  const colWs: number[] = r.columns.map((c) => mono.textW(c));
  const cellLayouts: CellLayout[][] = [];
  if (hasTable) {
    for (const row of r.rows) {
      const cells: CellLayout[] = [];
      row.forEach((v, j) => {
        const text = v === null ? "NULL" : v;
        const w = Math.min(mono.textW(text), MAX_CELL_W);
        if (w > colWs[j]) colWs[j] = w;
        cells.push({ lines: [], isNull: v === null });
      });
      cellLayouts.push(cells);
    }
    // 幅確定後に折り返しを計算
    r.rows.forEach((row, i) => {
      row.forEach((v, j) => {
        const text = v === null ? "NULL" : v;
        let lines = mono.wrap(text, colWs[j]);
        if (lines.length > MAX_CELL_LINES) {
          lines = lines.slice(0, MAX_CELL_LINES);
          lines[MAX_CELL_LINES - 1] += " …(省略)";
        }
        cellLayouts[i][j].lines = lines.length > 0 ? lines : [""];
      });
    });
  }

  const tableW = hasTable
    ? rownumW + colWs.reduce((a, w) => a + w + CELL_PAD_X * 2, 0)
    : 0;
  const contentW = Math.max(MIN_CONTENT_W, tableW);

  // SQL文の折り返し
  const sqlLines = mono.wrap(s.sql.trim(), contentW - 24);

  const headH = 26;
  const sqlH = sqlLines.length * LINE_H + 20;
  const metaH = 24;
  const theadH = LINE_H + CELL_PAD_Y * 2;
  const rowHs = cellLayouts.map(
    (cells) =>
      Math.max(1, ...cells.map((c) => c.lines.length)) * LINE_H + CELL_PAD_Y * 2
  );
  const tableH = hasTable ? theadH + rowHs.reduce((a, b) => a + b, 0) : 0;

  const width = contentW + MARGIN * 2;
  const height =
    MARGIN + headH + sqlH + 8 + metaH + tableH + MARGIN;

  // ---- 描画 ----

  const scale = Math.min(2, MAX_SIDE / Math.max(width, height));
  if (scale <= 0.05) throw new Error("結果が大きすぎて画像化できません");

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvasを初期化できません");
  ctx.scale(scale, scale);
  ctx.textBaseline = "middle";

  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, width, height);

  let y = MARGIN;

  // ヘッダ (ブランド + タブ番号 + 日時)
  ctx.font = FONT_BRAND;
  ctx.fillStyle = COLOR.brand;
  ctx.fillText("Quelio", MARGIN, y + headH / 2 - 4);
  if (total > 1) {
    ctx.font = FONT_MONO_SMALL;
    ctx.fillStyle = COLOR.dim;
    ctx.fillText(`${index + 1}/${total}`, MARGIN + 62, y + headH / 2 - 4);
  }
  {
    const ts = new Date().toLocaleString("ja-JP");
    ctx.font = FONT_MONO_SMALL;
    ctx.fillStyle = COLOR.faint;
    const w = ctx.measureText(ts).width;
    ctx.fillText(ts, width - MARGIN - w, y + headH / 2 - 4);
  }
  y += headH;

  // SQLボックス
  ctx.fillStyle = COLOR.sqlBg;
  ctx.strokeStyle = COLOR.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(MARGIN, y, contentW, sqlH, 8);
  } else {
    ctx.rect(MARGIN, y, contentW, sqlH);
  }
  ctx.fill();
  ctx.stroke();
  ctx.font = FONT_MONO;
  ctx.fillStyle = COLOR.text;
  sqlLines.forEach((line, i) => {
    ctx.fillText(line, MARGIN + 12, y + 10 + i * LINE_H + LINE_H / 2);
  });
  y += sqlH + 8;

  // メタ情報
  ctx.font = FONT_MONO_SMALL;
  ctx.fillStyle = COLOR.dim;
  ctx.fillText(metaLabel(s), MARGIN, y + metaH / 2 - 2);
  y += metaH;

  // テーブル
  if (hasTable) {
    const tx = MARGIN;
    // ヘッダ行
    ctx.fillStyle = COLOR.headBg;
    ctx.fillRect(tx, y, tableW, theadH);
    ctx.font = FONT_MONO;
    ctx.fillStyle = COLOR.dim;
    {
      let x = tx;
      const label = "#";
      ctx.fillText(
        label,
        x + rownumW - CELL_PAD_X - mono.textW(label),
        y + theadH / 2
      );
      x += rownumW;
      for (let j = 0; j < r.columns.length; j++) {
        ctx.fillText(r.columns[j], x + CELL_PAD_X, y + theadH / 2);
        x += colWs[j] + CELL_PAD_X * 2;
      }
    }
    y += theadH;

    // データ行
    for (let i = 0; i < r.rows.length; i++) {
      const rh = rowHs[i];
      if (i % 2 === 1) {
        ctx.fillStyle = COLOR.rowAlt;
        ctx.fillRect(tx, y, tableW, rh);
      }
      let x = tx;
      // 行番号
      ctx.font = FONT_MONO;
      ctx.fillStyle = COLOR.faint;
      const num = String(r.offset + i + 1);
      ctx.fillText(
        num,
        x + rownumW - CELL_PAD_X - mono.textW(num),
        y + CELL_PAD_Y + LINE_H / 2
      );
      x += rownumW;
      // セル
      for (let j = 0; j < r.columns.length; j++) {
        const cell = cellLayouts[i][j];
        ctx.fillStyle = cell.isNull ? COLOR.faint : COLOR.text;
        cell.lines.forEach((line, k) => {
          ctx.fillText(
            line,
            x + CELL_PAD_X,
            y + CELL_PAD_Y + k * LINE_H + LINE_H / 2
          );
        });
        x += colWs[j] + CELL_PAD_X * 2;
      }
      y += rh;
    }

    // 罫線
    ctx.strokeStyle = COLOR.gridLine;
    ctx.lineWidth = 1;
    const tableTop = y - tableH;
    ctx.beginPath();
    // 横線
    let ly = tableTop;
    for (const h of [theadH, ...rowHs]) {
      ctx.moveTo(tx, ly + 0.5);
      ctx.lineTo(tx + tableW, ly + 0.5);
      ly += h;
    }
    ctx.moveTo(tx, ly + 0.5);
    ctx.lineTo(tx + tableW, ly + 0.5);
    // 縦線
    let lx = tx;
    ctx.moveTo(lx + 0.5, tableTop);
    ctx.lineTo(lx + 0.5, ly);
    lx += rownumW;
    for (let j = 0; j <= r.columns.length; j++) {
      ctx.moveTo(lx + 0.5, tableTop);
      ctx.lineTo(lx + 0.5, ly);
      if (j < r.columns.length) lx += colWs[j] + CELL_PAD_X * 2;
    }
    ctx.stroke();
  }

  return canvas.toDataURL("image/png");
}

/**
 * 全結果タブをPNGとしてDownloadsに保存する。
 * 戻り値は保存したファイルパスの一覧。
 */
export async function captureResults(
  statements: StatementResult[]
): Promise<string[]> {
  const paths: string[] = [];
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

  for (let i = 0; i < statements.length; i++) {
    const dataUrl = renderSheet(statements[i], i, statements.length);
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const suffix = statements.length > 1 ? `_${i + 1}` : "";
    paths.push(await saveCapture(`quelio_${ts}${suffix}.png`, base64));
  }
  return paths;
}
