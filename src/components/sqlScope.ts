/**
 * 「今カーソルが居る場所から、どのテーブル・どの列が見えるか」を割り出す。
 *
 * これまでは文全体から `FROM 〜` を正規表現で拾っていたため、
 *   - `WITH t AS (...) SELECT ... FROM t` の `t`
 *   - `FROM (SELECT ...) x` の `x`
 * のように「実テーブルではない取得元」が分からず、補完が出なかった。
 *
 * ここでは括弧の対応を見て「入れ子になった問い合わせ」を切り出し、
 * その中の取得元と、導出表・WITH句が返す列名を割り出す。
 * 構文解析ではないので完全ではないが、書きかけのSQLでも壊れないことを優先している
 */
import {
  ID_SOURCE,
  mask,
  matchParen,
  readIdent,
  readQualified,
  readWord,
  skipWs,
  splitTop,
  topWords,
  unquote,
} from "./sqlText";

/** 取得元1つ */
export interface ScopeSource {
  /** 別名 (無ければ空) */
  alias: string;
  /** 実テーブル名 (導出表・WITH句なら空) */
  table: string;
  /** 導出表・WITH句が返す列名 (実テーブルなら null) */
  columns: string[] | null;
}

/** その場所から見えているもの */
export interface SqlScope {
  /** 取得元 (内側の問い合わせが先) */
  sources: ScopeSource[];
  /** WITH句で定義された名前 (テーブル名の候補に足す) */
  cteNames: string[];
}

/** テーブル名から列名を引く (知らないテーブルなら null) */
export type ColumnsOf = (table: string) => string[] | null;

/** 別名として扱わない語 */
const RESERVED = new Set([
  "on", "where", "set", "group", "order", "having", "limit", "offset",
  "join", "inner", "left", "right", "full", "cross", "outer", "natural",
  "using", "values", "select", "union", "except", "intersect", "and", "or",
  "window", "returning", "for", "lateral", "fetch", "partition", "add",
  "drop", "modify", "change", "rename", "alter", "if", "not", "exists",
  "as", "from", "into", "update", "delete", "insert", "with", "table",
  "when", "then", "else", "end", "case", "is", "null", "between", "like",
]);

/** 取得元の並びが終わる語 */
const END_OF_SOURCES = new Set([
  "where", "group", "order", "having", "limit", "offset", "window",
  "union", "except", "intersect", "returning", "fetch", "into", "set",
]);

/** 取得元が書かれる場所を示す語 */
const SOURCE_KEYWORDS = new Set(["from", "join", "into", "update", "table"]);

/** 集合演算 (ここで問い合わせが分かれる) */
const SET_OPS = new Set(["union", "except", "intersect", "minus"]);

/** 導出表をどこまで潜って調べるか (壊れたSQLで止まらなくなるのを防ぐ) */
const MAX_DEPTH = 4;

const QUALIFIED_ONLY = new RegExp(
  `^${ID_SOURCE}(?:\\s*\\.\\s*${ID_SOURCE})*$`
);
/** `式 AS 別名` / `式 別名` の別名部分 (直前が値の終わりのときだけ) */
const TRAILING_ALIAS = new RegExp(
  `[\\w$#\`")\\]]\\s+(?:as\\s+)?(${ID_SOURCE})\\s*$`,
  "i"
);

/** 解析の途中で持ち回すもの */
interface Ctx {
  masked: string;
  text: string;
  columnsOf: ColumnsOf;
  /** WITH句で定義された名前 → 列 (割り出せなければ null) */
  ctes: Map<string, string[] | null>;
}

/** 範囲 */
type Range = [number, number];

/** 集合演算で分かれた枝に切る (`select .. union select ..`) */
function branches(masked: string, [from, to]: Range): Range[] {
  const cuts: number[] = [];
  for (const w of topWords(masked, from, to)) {
    if (SET_OPS.has(w.text.toLowerCase())) cuts.push(w.end - w.text.length);
  }
  if (cuts.length === 0) return [[from, to]];
  const out: Range[] = [];
  let start = from;
  for (const at of cuts) {
    out.push([start, at]);
    start = at;
  }
  out.push([start, to]);
  return out;
}

/** 範囲の中の、いちばん外側にある語の位置 (無ければ -1) */
function findTopWord(
  masked: string,
  [from, to]: Range,
  names: Set<string> | string
): number {
  for (const w of topWords(masked, from, to)) {
    const lower = w.text.toLowerCase();
    const hit = typeof names === "string" ? lower === names : names.has(lower);
    if (hit) return w.end - w.text.length;
  }
  return -1;
}

/** WITH句を読む (無ければ空。読んだ分は本体の開始位置として返す) */
function readCtes(
  ctx: Ctx,
  [from, to]: Range,
  depth: number
): { start: number } {
  const { masked, text } = ctx;
  let i = skipWs(masked, from);
  const head = readWord(masked, i);
  if (!head || head.text.toLowerCase() !== "with") return { start: from };
  i = skipWs(masked, head.end);
  const rec = readWord(masked, i);
  if (rec && rec.text.toLowerCase() === "recursive") i = skipWs(masked, rec.end);

  while (i < to) {
    const name = readIdent(masked, text, i);
    if (!name) break;
    i = skipWs(masked, name.end);

    // WITH x(a, b) AS (...) — 列名が書いてあればそれを使う
    let columns: string[] | null = null;
    if (masked[i] === "(") {
      const close = matchParen(masked, i);
      if (close < 0 || close > to) break;
      columns = splitTop(masked, i + 1, close)
        .map((r) => unquote(text.slice(r[0], r[1]).trim()))
        .filter((c) => c !== "");
      i = skipWs(masked, close + 1);
    }

    // AS / NOT MATERIALIZED などを読み飛ばして本体の `(` まで進む
    while (i < to && masked[i] !== "(") {
      const w = readWord(masked, i);
      if (!w) break;
      i = skipWs(masked, w.end);
    }
    if (masked[i] !== "(") break;
    const close = matchParen(masked, i);
    if (close < 0 || close > to) break;

    ctx.ctes.set(
      unquote(name.text).toLowerCase(),
      columns ?? deriveColumns(ctx, [i + 1, close], depth + 1)
    );

    i = skipWs(masked, close + 1);
    if (masked[i] === ",") {
      i = skipWs(masked, i + 1);
      continue;
    }
    break;
  }
  return { start: i };
}

/** 取得元1つを読む */
function readSource(
  ctx: Ctx,
  at: number,
  to: number,
  depth: number
): { source: ScopeSource; end: number } | null {
  const { masked, text } = ctx;
  let i = skipWs(masked, at);

  // LATERAL / ONLY は飾りなので飛ばす
  for (;;) {
    const w = readWord(masked, i);
    if (!w || !/^(lateral|only)$/i.test(w.text)) break;
    i = skipWs(masked, w.end);
  }

  let name = "";
  let columns: string[] | null = null;

  if (masked[i] === "(") {
    // 導出表 — 中身から列を割り出す
    const close = matchParen(masked, i);
    if (close < 0 || close > to) return null;
    columns = deriveColumns(ctx, [i + 1, close], depth + 1);
    i = skipWs(masked, close + 1);
  } else {
    const id = readQualified(masked, text, i);
    if (!id) return null;
    name = unquote(id.text);
    if (RESERVED.has(name.toLowerCase())) return null;
    i = skipWs(masked, id.end);
    // テーブル関数 f(x) の引数は飛ばす
    if (masked[i] === "(") {
      const close = matchParen(masked, i);
      if (close < 0) return null;
      i = skipWs(masked, close + 1);
    }
  }

  // 別名
  let alias = "";
  const w = readWord(masked, i);
  if (w && w.text.toLowerCase() === "as") {
    const a = readIdent(masked, text, skipWs(masked, w.end));
    if (a) {
      alias = unquote(a.text);
      i = skipWs(masked, a.end);
    }
  } else {
    const a = readIdent(masked, text, i);
    if (a && !RESERVED.has(unquote(a.text).toLowerCase())) {
      alias = unquote(a.text);
      i = skipWs(masked, a.end);
    }
  }

  // 別名の後ろの列名 `t(a, b)` があれば、それを列として使う
  if (alias && masked[i] === "(") {
    const close = matchParen(masked, i);
    if (close >= 0 && close <= to) {
      const named = splitTop(masked, i + 1, close)
        .map((r) => unquote(text.slice(r[0], r[1]).trim()))
        .filter((c) => c !== "");
      if (named.length > 0) columns = named;
      i = skipWs(masked, close + 1);
    }
  }

  // WITH句で定義された名前なら、その列を使う
  const cte = ctx.ctes.get(name.toLowerCase());
  if (name && ctx.ctes.has(name.toLowerCase())) {
    return { source: { alias, table: "", columns: cte ?? null }, end: i };
  }
  return { source: { alias, table: name, columns }, end: i };
}

/** その問い合わせの取得元をすべて読む */
function readSources(ctx: Ctx, [from, to]: Range, depth: number): ScopeSource[] {
  const { masked } = ctx;
  const out: ScopeSource[] = [];
  let depthParen = 0;
  let i = from;
  while (i < to) {
    const c = masked[i];
    if (c === "(") {
      depthParen++;
      i++;
      continue;
    }
    if (c === ")") {
      depthParen--;
      i++;
      continue;
    }
    if (depthParen !== 0 || !/[A-Za-z_$#]/.test(c)) {
      i++;
      continue;
    }
    if (i > from && /[\w$#]/.test(masked[i - 1])) {
      i++;
      continue;
    }
    const w = readWord(masked, i);
    if (!w) {
      i++;
      continue;
    }
    const lower = w.text.toLowerCase();
    if (!SOURCE_KEYWORDS.has(lower)) {
      i = w.end;
      continue;
    }
    // FROM はカンマ区切りで複数書ける。JOIN や UPDATE は1つずつ
    const many = lower === "from";
    let j = skipWs(masked, w.end);
    for (;;) {
      const got = readSource(ctx, j, to, depth);
      if (!got) break;
      out.push(got.source);
      j = got.end;
      if (many && masked[j] === ",") {
        j = skipWs(masked, j + 1);
        continue;
      }
      break;
    }
    i = Math.max(j, w.end);
  }
  return out;
}

/** 取得元の並びから、見えている列をすべて集める */
function columnsOfSources(ctx: Ctx, sources: ScopeSource[]): string[] {
  const out: string[] = [];
  for (const s of sources) {
    const cols = s.columns ?? (s.table ? ctx.columnsOf(s.table) : null);
    if (cols) out.push(...cols);
  }
  return out;
}

/** `SELECT 〜 FROM` の並びから、その問い合わせが返す列名を割り出す */
function deriveColumns(
  ctx: Ctx,
  range: Range,
  depth: number
): string[] | null {
  if (depth > MAX_DEPTH) return null;
  const { masked, text } = ctx;

  // 括弧で包んであるだけなら中を見る
  const head = skipWs(masked, range[0]);
  if (masked[head] === "(") {
    const close = matchParen(masked, head);
    if (close >= 0 && skipWs(masked, close + 1) >= range[1]) {
      return deriveColumns(ctx, [head + 1, close], depth + 1);
    }
  }

  // WITH句があれば先に読む (中の導出表がその名前を使えるように)
  const inner: Ctx = { ...ctx, ctes: new Map(ctx.ctes) };
  const { start } = readCtes(inner, range, depth);
  // 集合演算で分かれているときは、いちばん左の枝が列名を決める
  const [from, to] = branches(masked, [start, range[1]])[0];

  const selAt = findTopWord(masked, [from, to], "select");
  if (selAt < 0) return null;
  let i = skipWs(masked, selAt + 6);
  // DISTINCT / ALL は飾りなので飛ばす
  const first = readWord(masked, i);
  if (first && /^(distinct|all)$/i.test(first.text)) i = skipWs(masked, first.end);

  const fromAt = findTopWord(masked, [i, to], "from");
  const stopAt = findTopWord(masked, [i, to], END_OF_SOURCES);
  const listEnd = Math.min(
    fromAt < 0 ? to : fromAt,
    stopAt < 0 ? to : stopAt
  );

  const sources = readSources(inner, [i, to], depth);
  const out: string[] = [];
  for (const [a, b] of splitTop(masked, i, listEnd)) {
    const item = text.slice(a, b).trim();
    if (item === "") continue;

    // `*` / `別名.*` は取得元の列をそのまま並べる
    if (item === "*") {
      out.push(...columnsOfSources(inner, sources));
      continue;
    }
    const star = /^(.+?)\s*\.\s*\*$/.exec(item);
    if (star) {
      const who = unquote(star[1]).toLowerCase();
      const hit = sources.filter(
        (s) => s.alias.toLowerCase() === who || s.table.toLowerCase() === who
      );
      out.push(...columnsOfSources(inner, hit));
      continue;
    }

    // `t.col` や `col` はそのまま列名になる
    if (QUALIFIED_ONLY.test(item)) {
      const last = item.split(".").pop() ?? item;
      out.push(unquote(last.trim()));
      continue;
    }

    // `式 AS 名前` / `式 名前`
    const alias = TRAILING_ALIAS.exec(item);
    if (alias) out.push(unquote(alias[1]));
    // 名前の付いていない式は列名が決まらないので出さない
  }

  // 重複を落として順を保つ
  return [...new Set(out.filter((c) => c !== ""))];
}

/**
 * カーソルの居る場所から見えている取得元を返す。
 *
 * 内側の問い合わせから順に並べるので、同じ別名があれば内側が勝つ。
 * 外側も残すのは、相関副問い合わせ (`WHERE o.id = (SELECT ... )`) で
 * 外側の別名を使うことがあるため
 */
export function scopeAt(
  statement: string,
  pos: number,
  columnsOf: ColumnsOf
): SqlScope {
  const masked = mask(statement);
  const ctx: Ctx = { masked, text: statement, columnsOf, ctes: new Map() };

  // pos を囲んでいる括弧のうち、問い合わせになっているものを内側から拾う
  const open: number[] = [];
  const limit = Math.max(0, Math.min(pos, masked.length));
  for (let i = 0; i < limit; i++) {
    if (masked[i] === "(") open.push(i);
    else if (masked[i] === ")") open.pop();
  }
  const ranges: Range[] = [];
  for (let k = open.length - 1; k >= 0; k--) {
    const at = open[k];
    if (!/^\s*\(*\s*(select|with)\b/i.test(masked.slice(at + 1, at + 40))) {
      continue;
    }
    const close = matchParen(masked, at);
    ranges.push([at + 1, close < 0 ? masked.length : close]);
  }
  ranges.push([0, masked.length]);

  /*
   * WITH句は外側から先に読む。
   * 内側の問い合わせが外側のWITH句の名前を使えるようにするため
   * (`WITH t AS (...) SELECT * FROM (SELECT * FROM t) x` の内側の `t`)
   */
  const bodyStart = new Map<Range, number>();
  for (const range of [...ranges].reverse()) {
    bodyStart.set(range, readCtes(ctx, range, 0).start);
  }

  // 取得元は内側から集める (同じ別名なら内側が勝つ)
  const sources: ScopeSource[] = [];
  for (const range of ranges) {
    const start = bodyStart.get(range) ?? range[0];
    // 集合演算で分かれているときは、カーソルの居る枝だけを見る
    const parts = branches(masked, [start, range[1]]);
    const here = parts.find(([a, b]) => pos >= a && pos <= b) ?? parts[0];
    sources.push(...readSources(ctx, here, 0));
  }

  return { sources, cteNames: [...ctx.ctes.keys()] };
}
