import { parseComment } from "./comment";
import type { ColumnInfo, SchemaEntry } from "./types";

/**
 * カラム定義から、ヘッダのツールチップに出す説明文を組み立てる。
 * 1行目: 論理名 / 2行目: 補足 / 最終行: 型などの属性
 */
export function columnTipText(c: ColumnInfo, delim: string): string {
  const [logical, note] = parseComment(c.comment ?? "", delim);
  const lines: string[] = [];
  if (logical) lines.push(logical);
  if (note) lines.push(note);
  const attrs = [c.colType];
  if (!c.nullable) attrs.push("NOT NULL");
  if (c.key === "PRI") attrs.push("主キー");
  lines.push(attrs.join(" / "));
  return lines.join("\n");
}

/** テーブル1つ分の「カラム名(小文字) → 説明文」を作る (データタブ用) */
export function buildColumnTips(
  columns: ColumnInfo[],
  delim: string
): Record<string, string> {
  const tips: Record<string, string> = {};
  for (const c of columns) {
    const key = c.name.toLowerCase();
    if (!(key in tips)) tips[key] = columnTipText(c, delim);
  }
  return tips;
}

/**
 * DB全体のカラム定義から「カラム名(小文字) → 説明文」を作る (SQL結果用)。
 * 任意のSQLの結果はどのテーブル由来か分からないため、
 * コメントが書かれているカラムだけを採用し、出典のテーブル名を添える。
 * 同名カラムが複数ある場合は最初に見つかった定義を使う
 */
export function buildSchemaTips(
  entries: SchemaEntry[],
  delim: string
): Record<string, string> {
  const tips: Record<string, string> = {};
  for (const e of entries) {
    const tname = e.table.schema
      ? `${e.table.schema}.${e.table.name}`
      : e.table.name;
    for (const c of e.detail.columns) {
      const key = c.name.toLowerCase();
      if (!c.comment || key in tips) continue;
      tips[key] = `${columnTipText(c, delim)}\n(${tname})`;
    }
  }
  return tips;
}
