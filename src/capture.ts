import { saveCapture } from "./api";
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

/** 1文ぶんをCanvasに描画してdataURLを返す */
function renderSheet(
  s: StatementResult,
  index: number,
  total: number
): string {
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
