import { format } from "sql-formatter";
import type { DbType, SqlFormatSettings } from "./types";
import { defaultSqlFormat } from "./types";

/**
 * SQLの整形。
 *
 * 書き方 (カンマの位置・大文字小文字・字下げ) は設定で変えられる。
 * 整形できないときは例外を投げる (呼び出し側でエラーを出す)。
 * 元のSQLは書き換えず、整形後の文字列を返す
 */

/** sql-formatter に渡す方言名 */
function language(dbType: DbType): "mysql" | "postgresql" | "sqlite" {
  if (dbType === "mysql") return "mysql";
  if (dbType === "sqlite") return "sqlite";
  return "postgresql";
}

/*
 * MySQL方言は `REPLACE(...)` を「REPLACE INTO文」と読んでしまい、
 * 関数呼び出しなのに改行が入った形になる。
 * 整形の間だけ別の名前へ逃がして、戻すときに元へ戻す
 */
const REPLACE_FN = /\breplace\s*\(/gi;
const REPLACE_MARK = "QUELIO_REPLACE_FN(";
const REPLACE_BACK = /QUELIO_REPLACE_FN\s*\(/g;

/**
 * 行末のカンマを次行の先頭に移す (カンマ先頭スタイル)。
 * 例: "  company_cd,"  →  "  company_cd" / "  , company_kbn"
 */
export function toLeadingCommas(sql: string): string {
  const lines = sql.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd().endsWith(",")) {
      // カンマを移す先 = 次の非空行
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length) {
        lines[i] = lines[i].trimEnd().slice(0, -1);
        lines[j] = lines[j].replace(/^(\s*)/, "$1, ");
      }
    }
  }
  return lines.join("\n");
}

/**
 * JOIN の ON を次の行へ出し、条件を一段下げる。
 *
 * 例:
 *   INNER JOIN m_shop b ON a.user_id = b.user_id
 * →
 *   INNER JOIN m_shop b
 *   ON
 *     a.user_id = b.user_id
 *
 * 続く AND / OR の行も同じ結合条件なので、まとめて一段下げる
 * (元の行の空白はそのまま残すので、幅をそろえる字下げでも列が崩れない)
 */
const JOIN_ON = /^(\s*)(.*\bJOIN\b.*?)\s+\b(ON)\b\s+(.+)$/i;
const COND_CONT = /^(\s*)(AND|OR)\b/i;

export function toOnNewline(sql: string, unit: string): string {
  const src = sql.split("\n");
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const m = JOIN_ON.exec(src[i]);
    if (!m) {
      out.push(src[i]);
      continue;
    }
    const [, indent, head, on, cond] = m;
    out.push(indent + head, indent + on, indent + unit + cond);
    // 同じ深さで続く AND / OR は、この ON の条件の続き
    while (i + 1 < src.length) {
      const next = COND_CONT.exec(src[i + 1]);
      if (!next || next[1] !== indent) break;
      out.push(unit + src[i + 1]);
      i++;
    }
  }
  return out.join("\n");
}

/** 字下げ1段ぶんの文字 */
function indentUnit(indent: SqlFormatSettings["indent"]): string {
  if (indent === "tab") return "\t";
  return indent === "4" ? "    " : "  ";
}

/** 設定の値が壊れていても落ちないよう、知らない値は既定へ戻す */
function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** 設定を sql-formatter に渡せる形にそろえる */
function sanitize(opts: SqlFormatSettings | undefined): SqlFormatSettings {
  const d = defaultSqlFormat();
  if (!opts) return d;
  return {
    commaStyle: pick(opts.commaStyle, ["leading", "trailing"] as const, d.commaStyle),
    keywordCase: pick(
      opts.keywordCase,
      ["upper", "lower", "preserve"] as const,
      d.keywordCase
    ),
    indent: pick(opts.indent, ["2", "4", "tab"] as const, d.indent),
    logicalNewline: pick(
      opts.logicalNewline,
      ["before", "after"] as const,
      d.logicalNewline
    ),
    indentStyle: pick(
      opts.indentStyle,
      ["standard", "tabularLeft", "tabularRight"] as const,
      d.indentStyle
    ),
    onClause: pick(opts.onClause, ["same", "newline"] as const, d.onClause),
  };
}

/** 整形する。整形できないときは例外を投げる */
export function formatSql(
  sql: string,
  dbType: DbType,
  options?: SqlFormatSettings
): string {
  const opts = sanitize(options);
  const escaped = sql.replace(REPLACE_FN, REPLACE_MARK);
  const formatted = format(escaped, {
    language: language(dbType),
    keywordCase: opts.keywordCase,
    indentStyle: opts.indentStyle,
    logicalOperatorNewline: opts.logicalNewline,
    useTabs: opts.indent === "tab",
    // タブのときは幅の指定を見ない (整形器がタブ1文字を使う)
    tabWidth: opts.indent === "4" ? 4 : 2,
    /*
     * `:name` `@name` をパラメータとして読ませる。
     * 指定しないとMySQL・SQLiteでは `:name` が構文エラーになり、
     * PostgreSQLでは `@name` が `@ name` に割られて壊れる。
     * 文字列リテラルの中の `:name` は対象にならない (整形器が字句で見るため)
     */
    paramTypes: { named: [":", "@"] },
  });
  let out = formatted.replace(REPLACE_BACK, "REPLACE(");
  if (opts.onClause === "newline") {
    out = toOnNewline(out, indentUnit(opts.indent));
  }
  return opts.commaStyle === "leading" ? toLeadingCommas(out) : out;
}

/** 例外から、画面に出す1行のメッセージを作る */
export function formatErrorMessage(e: unknown): string {
  const msg = String(e).split("\n")[0].replace(/^Error:\s*/, "");
  return `整形できません: ${msg}`;
}
