/**
 * カラムの日本語名 (コメントの論理名) の取り出し。
 *
 * 結果グリッドのヘッダに英語名と並べて出すためのもの。
 * ツールチップの文 (columnTips) は型や補足も混ぜた別物なので分けてある
 */
import { parseComment } from "./comment";
import type { ColumnInfo, SchemaEntry } from "./types";

/**
 * テーブル1つ分の「カラム名(小文字) → 日本語名」 (データタブ用)。
 *
 * 同名のカラムがあれば、日本語名が書かれている最初のものを採る
 */
export function buildColumnLabels(
  columns: ColumnInfo[],
  delim: string
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const c of columns) {
    const key = c.name.toLowerCase();
    if (key in labels) continue;
    const [logical] = parseComment(c.comment ?? "", delim);
    if (logical) labels[key] = logical;
  }
  return labels;
}

/**
 * DB全体の「カラム名(小文字) → 日本語名」 (SQL結果用)。
 *
 * 任意のSQLの結果はどのテーブル由来か分からないので、
 * DB全体から同名のカラムを探す形になる (columnTips と同じ考え方)
 */
export function buildSchemaLabels(
  entries: SchemaEntry[],
  delim: string
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const e of entries) {
    for (const c of e.detail.columns) {
      const key = c.name.toLowerCase();
      if (!c.comment || key in labels) continue;
      const [logical] = parseComment(c.comment, delim);
      if (logical) labels[key] = logical;
    }
  }
  return labels;
}
