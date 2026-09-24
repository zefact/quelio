import { format } from "sql-formatter";
import {
  escapeKeywordFunctions,
  restoreKeywordFunctions,
} from "./sqlFnEscape";
import type { DbType, SqlFormatSettings } from "./types";
import { defaultSqlFormat } from "./types";
import { toLeadingCommas } from "./sqlLeadingComma";
import { toOnNewline } from "./sqlOnClause";

/* 以前ここにあった2つの並べ替えは、コメントの扱いが増えたので別ファイルに分けた */
export { toLeadingCommas } from "./sqlLeadingComma";
export { toOnNewline } from "./sqlOnClause";

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
  /*
   * `TRUNCATE(...)` `REPLACE(...)` などは、そのまま渡すと
   * 文の始まりと読まれて字下げが崩れる。整形の間だけ名前を逃がす
   */
  const escaped = escapeKeywordFunctions(sql);
  const formatted = format(escaped.sql, {
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
  let out = restoreKeywordFunctions(formatted, escaped.names);
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
