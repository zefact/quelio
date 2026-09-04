/**
 * SQL関数のリファレンス。
 *
 * 「関数の書き方を忘れて調べに行く」のを無くすために、
 * 書式・1行の説明・そのまま実行できる例をアプリの中に持つ。
 *
 * 例と結果は、手元に立てた MySQL / PostgreSQL で実際に流して
 * 合っていることを確かめてある
 */
import type { DbType } from "../types";
import type { SqlFuncGroup } from "./types";
import { MYSQL_TEXT } from "./mysql/text";
import { MYSQL_NUMBER } from "./mysql/number";
import { MYSQL_DATETIME } from "./mysql/datetime";
import { MYSQL_AGGREGATE } from "./mysql/aggregate";
import { MYSQL_MISC } from "./mysql/misc";
import { PG_TEXT } from "./postgres/text";
import { PG_NUMBER } from "./postgres/number";
import { PG_DATETIME } from "./postgres/datetime";
import { PG_AGGREGATE } from "./postgres/aggregate";
import { PG_MISC } from "./postgres/misc";

export type { SqlFunc, SqlFuncGroup } from "./types";
export { searchFunctions, flatten } from "./search";
export type { SqlFuncHit } from "./search";
export { snippetOf } from "./snippet";

/** 分類の並び順 (どのDBでもこの順で出す) */
const ORDER = [
  "文字列",
  "正規表現",
  "数値",
  "型変換",
  "日付・時刻",
  "集約",
  "ウィンドウ",
  "条件・NULL",
  "JSON",
  "配列",
  "その他",
];

/** 決めた順に並べ直す (定義したファイルの順に引きずられないように) */
function ordered(groups: SqlFuncGroup[]): SqlFuncGroup[] {
  return [...groups].sort(
    (a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category)
  );
}

const MYSQL = ordered([
  ...MYSQL_TEXT,
  ...MYSQL_NUMBER,
  ...MYSQL_DATETIME,
  ...MYSQL_AGGREGATE,
  ...MYSQL_MISC,
]);

const POSTGRES = ordered([
  ...PG_TEXT,
  ...PG_NUMBER,
  ...PG_DATETIME,
  ...PG_AGGREGATE,
  ...PG_MISC,
]);

/**
 * そのDBの関数を返す。
 *
 * まだ用意していないDB (SQLite / Valkey) では空になる。
 * 画面側はその場合「用意していない」と出す
 */
export function functionsFor(dbType: DbType): SqlFuncGroup[] {
  switch (dbType) {
    case "mysql":
      return MYSQL;
    case "postgresql":
      return POSTGRES;
    default:
      return [];
  }
}

/** そのDBの関数の数 (画面の見出しに出す) */
export function functionCount(dbType: DbType): number {
  return functionsFor(dbType).reduce((n, g) => n + g.items.length, 0);
}
