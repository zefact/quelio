import { format } from "sql-formatter";
import type { DbType } from "./types";

/**
 * SQLの整形。
 *
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

/** 整形する (カンマ先頭スタイル)。整形できないときは例外を投げる */
export function formatSql(sql: string, dbType: DbType): string {
  const escaped = sql.replace(REPLACE_FN, REPLACE_MARK);
  const formatted = format(escaped, {
    language: language(dbType),
    keywordCase: "upper",
    tabWidth: 2,
    /*
     * `:name` `@name` をパラメータとして読ませる。
     * 指定しないとMySQL・SQLiteでは `:name` が構文エラーになり、
     * PostgreSQLでは `@name` が `@ name` に割られて壊れる。
     * 文字列リテラルの中の `:name` は対象にならない (整形器が字句で見るため)
     */
    paramTypes: { named: [":", "@"] },
  });
  return toLeadingCommas(formatted.replace(REPLACE_BACK, "REPLACE("));
}

/** 例外から、画面に出す1行のメッセージを作る */
export function formatErrorMessage(e: unknown): string {
  const msg = String(e).split("\n")[0].replace(/^Error:\s*/, "");
  return `整形できません: ${msg}`;
}
