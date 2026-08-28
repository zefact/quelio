import type { QueryResult } from "../types";

/** 結果セットを返さない実行 (INSERT/UPDATE等) の結果かどうか */
export function isExecResult(r: QueryResult): boolean {
  return r.rowsAffected !== null && r.rowsAffected !== undefined;
}

/** 結果タブのラベル: "1: SELECT" のように文の種類を添える */
export function statementLabel(sql: string, index: number): string {
  const head = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? "SQL";
  return `${index + 1}: ${head}`;
}
