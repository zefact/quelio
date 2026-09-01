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

/** そのまま書ける識別子の形 (英字か_で始まり、英数字と_だけ) */
const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 引用符を外すと意味が変わる語。
 *
 * 網羅はしない (DB・バージョンで違う)。よく列名に使われて、
 * かつ裸で書くと構文エラーになりうるものを入れてある。
 * 迷ったら引用する側に倒す (引用しても動作は変わらないため)
 */
const RESERVED = new Set([
  "add", "all", "alter", "and", "any", "as", "asc", "before", "between",
  "binary", "both", "by", "call", "case", "cast", "char", "character",
  "check", "collate", "column", "condition", "constraint", "create",
  "cross", "current_date", "current_time", "current_timestamp",
  "current_user", "database", "databases", "day", "dec", "decimal",
  "declare", "default", "delete", "desc", "describe", "distinct", "div",
  "double", "drop", "dual", "each", "else", "elseif", "end", "escape",
  "except", "exists", "explain", "false", "fetch", "float", "for", "force",
  "foreign", "from", "full", "function", "grant", "group", "having", "hour",
  "if", "ignore", "in", "index", "infile", "inner", "insert", "int",
  "integer", "intersect", "interval", "into", "is", "join", "key", "keys",
  "kill", "leading", "leave", "left", "like", "limit", "lines", "load",
  "lock", "long", "loop", "match", "minute", "mod", "month", "natural",
  "not", "null", "numeric", "offset", "on", "only", "optimize", "option",
  "or", "order", "outer", "over", "partition", "precision", "primary",
  "procedure", "range", "rank", "read", "real", "references", "regexp",
  "release", "rename", "repeat", "replace", "require", "restrict", "return",
  "revoke", "right", "rlike", "row", "rows", "schema", "second", "select",
  "session_user", "set", "show", "smallint", "some", "table", "then", "time",
  "timestamp", "tinyint", "to", "trailing", "trigger", "true", "union",
  "unique", "unlock", "update", "usage", "use", "user", "using", "values",
  "varchar", "varying", "when", "where", "while", "window", "with", "write",
  "xor", "year", "zerofill",
]);

/**
 * 引用符を付けないと困る名前か。
 *
 * PostgreSQLは引用符なしの識別子を小文字として扱うので、
 * 大文字を含む名前は引用符が要る
 * (MySQLとSQLiteは裸でも大文字小文字を気にしない)
 */
export function needsQuote(dbType: DbType, name: string): boolean {
  if (!PLAIN_IDENT.test(name)) return true;
  if (RESERVED.has(name.toLowerCase())) return true;
  return dbType === "postgresql" && name !== name.toLowerCase();
}

/**
 * 必要なときだけ引用符を付ける。
 *
 * 画面で組み立てたSQLをそのまま人が読む場所 (絞り込みの条件など) では、
 * 付けなくてよい引用符が付いていると読みにくいため
 */
export function quoteIdentIfNeeded(dbType: DbType, name: string): string {
  return needsQuote(dbType, name) ? quoteIdent(dbType, name) : name;
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

/**
 * テーブルの列を並べたSELECT文。
 * `SELECT *` と違って、あとから列を消すだけで絞り込める
 */
export function buildSelectStatement(
  dbType: DbType,
  table: TableInfo,
  columns: string[]
): string {
  const cols = columns.length
    ? columns.map((c) => quoteIdent(dbType, c)).join(",\n  ")
    : "*";
  return `SELECT\n  ${cols}\nFROM ${quoteTable(dbType, table)};`;
}

/**
 * 列を並べたINSERT文のひな形。
 * 値はすべてNULLにしておくので、必要なところだけ書き換えて使う
 */
export function buildInsertStatement(
  dbType: DbType,
  table: TableInfo,
  columns: string[]
): string {
  if (columns.length === 0) {
    return `INSERT INTO ${quoteTable(dbType, table)} () VALUES ();`;
  }
  const cols = columns.map((c) => quoteIdent(dbType, c)).join(",\n  ");
  const values = columns.map(() => "NULL").join(",\n  ");
  return `INSERT INTO ${quoteTable(dbType, table)} (\n  ${cols}\n) VALUES (\n  ${values}\n);`;
}

/** 正確な件数を数えるSELECT文 */
export function buildCountStatement(
  dbType: DbType,
  table: TableInfo
): string {
  return `SELECT COUNT(*) FROM ${quoteTable(dbType, table)};`;
}

/**
 * テーブルを空にするSQL。
 * SQLiteにTRUNCATEは無いので DELETE を使う (どちらも取り消せない)
 */
export function buildTruncateStatement(
  dbType: DbType,
  table: TableInfo
): string {
  const t = quoteTable(dbType, table);
  return dbType === "sqlite"
    ? `DELETE FROM ${t};`
    : `TRUNCATE TABLE ${t};`;
}
