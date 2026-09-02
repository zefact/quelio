/**
 * 「列・演算子・値」から WHERE句を組み立てる。
 *
 * SQLを書かない人でも絞り込めるようにするのが目的。
 * 組み立てた文はそのまま画面の入力欄に入れて見せる (何が起きたのか分かるように)
 */
import { columnValueKind } from "./columnType";
import type { ValueKind } from "./columnType";

/** 使える演算子 */
export type OpKind =
  | "eq"
  | "ne"
  | "gt"
  | "ge"
  | "lt"
  | "le"
  | "contains"
  | "starts"
  | "ends"
  | "in"
  | "null"
  | "notnull";

export interface FilterOp {
  id: OpKind;
  label: string;
  /** 値の入力が要るか (IS NULL などは要らない) */
  needsValue: boolean;
}

export const OPS: FilterOp[] = [
  { id: "eq", label: "= 等しい", needsValue: true },
  { id: "ne", label: "<> 等しくない", needsValue: true },
  { id: "gt", label: "> より大きい", needsValue: true },
  { id: "ge", label: ">= 以上", needsValue: true },
  { id: "lt", label: "< より小さい", needsValue: true },
  { id: "le", label: "<= 以下", needsValue: true },
  { id: "contains", label: "含む", needsValue: true },
  { id: "starts", label: "で始まる", needsValue: true },
  { id: "ends", label: "で終わる", needsValue: true },
  { id: "in", label: "いずれか (カンマ区切り)", needsValue: true },
  { id: "null", label: "空 (NULL)", needsValue: false },
  { id: "notnull", label: "空でない", needsValue: false },
];

/** 1つの条件 */
export interface FilterCond {
  column: string;
  op: OpKind;
  value: string;
}

/** 値の入力が要る演算子か */
export function needsValue(op: OpKind): boolean {
  return OPS.find((o) => o.id === op)?.needsValue ?? true;
}

/** 引用符なしで数値として書ける値か */
export function isNumericLiteral(v: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(v.trim());
}

/** 値を文字列リテラルにする (シングルクォートは2つ重ねて逃がす) */
export function quoteValue(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** 列名からその列の型を引く (分からなければ空文字を返す) */
export type TypeOf = (column: string) => string | undefined;

/**
 * 値をSQLの書き方に直す。
 *
 * 列の型が分かっていれば、それに従う。
 * 数値の列だけ引用符を外し、それ以外は数字だけの値でも引用符で囲む
 * (`varchar` の "0123" を 123 にしてしまわないため)
 */
function literal(v: string, kind: ValueKind | null): string {
  const t = v.trim();
  switch (kind) {
    case "number":
      // 数として読めない値は囲んでおく (文のかたちだけは崩さない)
      return isNumericLiteral(t) ? t : quoteValue(v);
    case "bool":
      if (/^(true|false)$/i.test(t)) return t.toUpperCase();
      return isNumericLiteral(t) ? t : quoteValue(v);
    case "text":
      return quoteValue(v);
    default:
      // 型が分からないときは、これまで通り値の見た目で決める
      if (isNumericLiteral(t)) return t;
      if (/^(true|false|null)$/i.test(t)) return t.toUpperCase();
      return quoteValue(v);
  }
}

/** 条件1つをSQLにする (書けない条件はnull) */
export function condSql(
  cond: FilterCond,
  quoteName: (name: string) => string,
  typeOf?: TypeOf
): string | null {
  if (!cond.column) return null;
  const col = quoteName(cond.column);
  if (cond.op === "null") return `${col} IS NULL`;
  if (cond.op === "notnull") return `${col} IS NOT NULL`;
  const v = cond.value;
  if (v.trim() === "") return null;
  const kind = typeOf ? columnValueKind(typeOf(cond.column)) : null;
  const lit = (x: string) => literal(x, kind);
  switch (cond.op) {
    case "eq":
      return `${col} = ${lit(v)}`;
    case "ne":
      return `${col} <> ${lit(v)}`;
    case "gt":
      return `${col} > ${lit(v)}`;
    case "ge":
      return `${col} >= ${lit(v)}`;
    case "lt":
      return `${col} < ${lit(v)}`;
    case "le":
      return `${col} <= ${lit(v)}`;
    case "contains":
      return `${col} LIKE ${quoteValue(`%${v}%`)}`;
    case "starts":
      return `${col} LIKE ${quoteValue(`${v}%`)}`;
    case "ends":
      return `${col} LIKE ${quoteValue(`%${v}`)}`;
    case "in": {
      const items = v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      if (items.length === 0) return null;
      return `${col} IN (${items.map(lit).join(", ")})`;
    }
  }
}

/** 条件をすべて AND で繋いだ WHERE句を返す (書けるものが無ければ空文字) */
export function buildWhere(
  conds: FilterCond[],
  quoteName: (name: string) => string,
  typeOf?: TypeOf
): string {
  return conds
    .map((c) => condSql(c, quoteName, typeOf))
    .filter((s): s is string => s !== null)
    .join(" AND ");
}
