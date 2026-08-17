import type { DbType, TableInfo } from "./types";

/** テーブルの識別キー ("schema.name")。選択状態の比較に使う */
export function tableKey(t: TableInfo): string {
  return `${t.schema ?? ""}.${t.name}`;
}

/** 識別子をDB種別に応じてクォートする (MySQL: `` ` `` / PostgreSQL: `"`) */
export function quoteIdent(dbType: DbType, name: string): string {
  return dbType === "mysql"
    ? `\`${name.replace(/`/g, "``")}\``
    : `"${name.replace(/"/g, '""')}"`;
}

/** スキーマ付きテーブル名をクォートして返す (schemaが無ければテーブル名のみ) */
export function quoteTable(dbType: DbType, table: TableInfo): string {
  const name = quoteIdent(dbType, table.name);
  return table.schema ? `${quoteIdent(dbType, table.schema)}.${name}` : name;
}

/**
 * 絞り込み入力を条件式へ正規化する。
 * 先頭の "WHERE" と末尾のセミコロンを取り除き、
 * 利用者が "WHERE id > 10" と入力しても扱えるようにする
 */
export function normalizeWhere(where: string): string {
  return where
    .trim()
    .replace(/;+\s*$/, "")
    .replace(/^where\s+/i, "")
    .trim();
}

/**
 * データタブ用のSELECT文を組み立てる。
 * LIMIT/OFFSETはバックエンド側のページング処理が付与するためここでは付けない
 */
export function buildTableSelect(
  dbType: DbType,
  table: TableInfo,
  where: string
): string {
  const cond = normalizeWhere(where);
  const base = `SELECT * FROM ${quoteTable(dbType, table)}`;
  return cond ? `${base} WHERE ${cond}` : base;
}
