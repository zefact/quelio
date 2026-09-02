/**
 * カラムの型名から、値をSQLにどう書くかを決める。
 *
 * 値の見た目だけで決めると、`varchar` の "0123" が数値の 123 になってしまう。
 * MySQLでは暗黙の型変換で拾えてしまうことがある一方、
 * PostgreSQLでは型が合わずエラーになるため、型を見て決める
 */

/** 値の書き方 */
export type ValueKind = "number" | "bool" | "text";

/**
 * 引用符を付けずに書ける数値の型。
 *
 * MySQL / PostgreSQL / SQLite で使う名前をまとめて並べる。
 * `int unsigned` や `numeric(10,2)` のような後ろの飾りは先に落とす
 */
const NUMBER_TYPES = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
  "int2",
  "int4",
  "int8",
  "serial",
  "serial2",
  "serial4",
  "serial8",
  "smallserial",
  "bigserial",
  "decimal",
  "dec",
  "numeric",
  "fixed",
  "float",
  "float4",
  "float8",
  "double",
  "real",
  "money",
]);

/** 真偽値の型 */
const BOOL_TYPES = new Set(["bool", "boolean"]);

/**
 * 型名の先頭の語を取り出す。
 *
 * `int(11) unsigned` → `int`、`character varying(20)` → `character`、
 * `double precision` → `double`
 */
function baseType(colType: string): string {
  return colType.trim().toLowerCase().split(/[\s(]/)[0] ?? "";
}

/**
 * カラムの型から値の書き方を決める。
 *
 * 型が分からないとき (SQLiteで型を書いていない列など) は null を返し、
 * 呼び出し側で「値の見た目から決める」に任せる
 */
export function columnValueKind(colType: string | undefined): ValueKind | null {
  const base = baseType(colType ?? "");
  if (!base) return null;
  if (BOOL_TYPES.has(base)) return "bool";
  if (NUMBER_TYPES.has(base)) return "number";
  // 日付・JSON・UUID なども含めて、数でないものは引用符で囲む
  return "text";
}
