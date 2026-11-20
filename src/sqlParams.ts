/**
 * SQLパラメータ (:name / @name) の抽出と値の埋め込み。
 * 文字列リテラル・コメントの中は対象外とし、
 * PostgreSQLのキャスト (::type) やシステム変数 (@@var) は無視する。
 *
 * 文字列やコメントの読み方は接続先で変わる (値を埋め込むバックエンドの
 * src-tauri/src/query/lexer.rs と同じにそろえる)。そろっていないと、
 * 文字列の中の `:` をパラメータと思って入力欄を出してしまう
 * (たとえば PostgreSQL の `$q$ … 例:「…」 … $q$`)
 */
import type { DbType } from "./types";

/**
 * パラメータ名の1文字目と2文字目以降に使える文字。
 * 文字 (日本語を含む) と数字と `_` だけ。`「` `、` `。` などの記号は名前にしない
 * (バックエンドの params.rs の name_start / name_char と同じ)
 */
const NAME_START = /[\p{Alphabetic}_]/u;
const NAME_CHAR = /[\p{Alphabetic}\p{N}_]/u;

/** 接続先ごとの読み方の違い */
interface ScanOpts {
  /** `#` から行末までがコメント (MySQL) */
  hashComment: boolean;
  /** `--` の直後に空白が要る (MySQL。`1--2` は引き算) */
  dashNeedsSpace: boolean;
  /** 文字列の中で `\` が次の1文字を逃がす (MySQLの既定) */
  backslash: boolean;
  /** `$タグ$ … $タグ$` の引用 (PostgreSQL) */
  dollarQuote: boolean;
}

/**
 * 接続先に合わせた読み方。
 * 接続先が分からないときは、前からの読み方 (MySQL寄り) にする
 */
function scanOptsFor(dbType?: DbType): ScanOpts {
  switch (dbType) {
    case "postgresql":
      return {
        hashComment: false,
        dashNeedsSpace: false,
        backslash: false,
        dollarQuote: true,
      };
    case "sqlite":
      return {
        hashComment: false,
        dashNeedsSpace: false,
        backslash: false,
        dollarQuote: false,
      };
    case "mysql":
      return {
        hashComment: true,
        dashNeedsSpace: true,
        backslash: true,
        dollarQuote: false,
      };
    default:
      return {
        hashComment: true,
        dashNeedsSpace: false,
        backslash: true,
        dollarQuote: false,
      };
  }
}

/** スキャナ: SQL中のパラメータ出現位置を列挙する */
interface ParamHit {
  /** プレフィックスを含む開始位置 */
  start: number;
  /** 終了位置 (exclusive) */
  end: number;
  /** プレフィックスを除いた名前 */
  name: string;
}

/** 位置 i の `$` の直前が名前の一部か (`a$b$c` は名前なので引用符ではない) */
function identBefore(sql: string, i: number): boolean {
  return i > 0 && /[\p{Alphabetic}\p{N}_$]/u.test(sql[i - 1]);
}

/**
 * 位置 i から始まる `$タグ$` の終わりの次の位置。その形でなければ -1。
 * タグは数字で始められない (`$1` は位置パラメータであって引用符ではない)
 */
function dollarTagEnd(sql: string, i: number): number {
  if (/[0-9]/.test(sql[i + 1] ?? "")) return -1;
  let j = i + 1;
  while (j < sql.length && /[\p{Alphabetic}\p{N}_]/u.test(sql[j])) j++;
  return sql[j] === "$" ? j + 1 : -1;
}

function scan(sql: string, opts: ScanOpts): ParamHit[] {
  const hits: ParamHit[] = [];
  let i = 0;
  const n = sql.length;

  /**
   * 位置 j の1文字 (サロゲートペアは2つで1文字)。
   * 「𠮷」のような字も名前に使えるように、コード単位ではなく文字で見る
   */
  const charAt = (j: number): string =>
    j < n ? String.fromCodePoint(sql.codePointAt(j) as number) : "";
  const isNameStart = (j: number): boolean => NAME_START.test(charAt(j));
  const readName = (from: number): number => {
    let j = from;
    while (j < n && NAME_CHAR.test(charAt(j))) j += charAt(j).length;
    return j;
  };

  while (i < n) {
    const c = sql[i];

    // 文字列リテラル ('...' / "..." / `...`)。'' と (MySQLでは) \' のエスケープに対応
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      // 逃がせるのは文字列だけ。名前を囲む " や ` の中では `\` はただの文字
      const escapes = opts.backslash && quote === "'";
      i++;
      while (i < n) {
        if (escapes && sql[i] === "\\") {
          i += 2;
        } else if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2; // '' のエスケープ
          } else {
            i++;
            break;
          }
        } else {
          i++;
        }
      }
      continue;
    }

    // $タグ$ … $タグ$ (PostgreSQL)。閉じていなければ末尾まで文字列
    if (opts.dollarQuote && c === "$" && !identBefore(sql, i)) {
      const head = dollarTagEnd(sql, i);
      if (head > 0) {
        const tag = sql.slice(i, head);
        const close = sql.indexOf(tag, head);
        i = close < 0 ? n : close + tag.length;
        continue;
      }
    }

    // 行コメント
    if (
      c === "-" &&
      sql[i + 1] === "-" &&
      (!opts.dashNeedsSpace || i + 2 >= n || /\s/.test(sql[i + 2]))
    ) {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (opts.hashComment && c === "#") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    // ブロックコメント
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }

    // :param (::キャストと := は除外)
    if (c === ":") {
      if (sql[i + 1] === ":") {
        i += 2;
        // ::type の型名を読み飛ばす (型名中の文字を誤検出しないように)
        continue;
      }
      if (sql[i + 1] === "=") {
        i += 2;
        continue;
      }
      if (isNameStart(i + 1)) {
        const end = readName(i + 1);
        hits.push({ start: i, end, name: sql.slice(i + 1, end) });
        i = end;
        continue;
      }
      i++;
      continue;
    }

    // @param (@@システム変数は除外)
    if (c === "@") {
      if (sql[i + 1] === "@") {
        i += 2;
        const end = readName(i);
        i = end;
        continue;
      }
      if (isNameStart(i + 1)) {
        const end = readName(i + 1);
        hits.push({ start: i, end, name: sql.slice(i + 1, end) });
        i = end;
        continue;
      }
      i++;
      continue;
    }

    i++;
  }
  return hits;
}

/** SQLからパラメータ名を出現順 (重複なし) に抽出する */
export function extractParams(sql: string, dbType?: DbType): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of scan(sql, scanOptsFor(dbType))) {
    if (!seen.has(h.name)) {
      seen.add(h.name);
      out.push(h.name);
    }
  }
  return out;
}

/** パラメータの埋め込み方 */
export type ParamKind = "auto" | "string" | "number" | "raw";

export interface ParamValue {
  value: string;
  kind: ParamKind;
}

export const PARAM_KINDS: [ParamKind, string][] = [
  ["auto", "自動"],
  ["string", "文字列"],
  ["number", "数値"],
  ["raw", "そのまま"],
];

/**
 * SQL中でパラメータと比較されているカラム名を推測する。
 * 例: "u.code = :code" → "code" / ":d <= created_at" → "created_at"
 */
export function guessParamColumn(sql: string, name: string): string | null {
  const id = "[A-Za-z_][A-Za-z0-9_$]*(?:\\.[A-Za-z_][A-Za-z0-9_$]*)*";
  const op = "(?:[=<>!]{1,2}|LIKE|like|Like)";
  const before = new RegExp(`(${id})\\s*${op}\\s*[:@]${name}\\b`);
  const after = new RegExp(`[:@]${name}\\b\\s*${op}\\s*(${id})`);
  const m = sql.match(before) ?? sql.match(after);
  if (!m) return null;
  const parts = m[1].split(".");
  return parts[parts.length - 1];
}

/** カラム型の文字列が数値型かどうか */
export function isNumericType(colType: string): boolean {
  return /int|decimal|numeric|float|double|real|serial|year|bit/i.test(colType);
}
