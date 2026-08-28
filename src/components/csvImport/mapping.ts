/**
 * CSVの列と取り込み先の列の割り当て。
 *
 * 画面から切り離して、突き合わせの決まりだけをここに置く
 */

import type { ColumnInfo, DbType, ImportMode } from "../../types";

/** 見出しを突き合わせるための正規化 (大小文字・空白・区切り記号を無視する) */
export function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]/g, "");
}

/**
 * CSVの列を取り込み先の列へ自動で割り当てる。
 *
 * @param byName 見出し名で突き合わせる (falseなら左から順番に当てる)
 * @returns CSVの列と同じ長さの配列 (割り当て先が無ければnull)
 */
export function autoMap(
  csvColumns: string[],
  targets: string[],
  byName: boolean
): (string | null)[] {
  // 見出し行が無いファイルは名前で突き合わせようがないので、並び順で当てる
  if (!byName) return csvColumns.map((_, i) => targets[i] ?? null);

  /** まだ割り当てていない取り込み先 (正規化した名前 → 元の名前) */
  const free = new Map<string, string>();
  for (const t of targets) {
    const k = normalizeName(t);
    if (!free.has(k)) free.set(k, t);
  }
  return csvColumns.map((c) => {
    const hit = free.get(normalizeName(c));
    if (hit === undefined) return null;
    // 1つの取り込み先を2つの列へ割り当てない
    free.delete(normalizeName(c));
    return hit;
  });
}

/** 割り当ての問題点 */
export interface MappingIssue {
  /** error は実行できない / warn は実行はできるが確認してほしい */
  level: "error" | "warn";
  message: string;
}

/**
 * 値を渡してはいけない列か (DBが必ず値を決める)。
 *
 * MySQLの生成列は `VIRTUAL GENERATED` / `STORED GENERATED`、
 * PostgreSQLは `identity always` / `stored generated`。
 * MySQLは既定値式の列にも `DEFAULT_GENERATED` を入れるので、
 * 単語で区切って見ないと普通の `created_at` まで巻き込む
 */
export function readOnlyColumn(c: ColumnInfo): boolean {
  return /(^|\s)(identity always|(virtual|stored) generated)(?![a-z0-9_])/i.test(
    c.extra ?? ""
  );
}

/**
 * DBが値を作ってくれる列か (未選択でも構わない列)。
 *
 * MySQLは `auto_increment`、PostgreSQLは IDENTITY を `extra` に入れる。
 * SQLiteは `extra` を持たないので、`INTEGER PRIMARY KEY` が
 * 暗黙のrowid別名になることを型名から見分ける
 */
export function generated(c: ColumnInfo, dbType: DbType): boolean {
  const extra = (c.extra ?? "").toLowerCase();
  if (extra.includes("auto_increment") || extra.includes("identity")) {
    return true;
  }
  if (readOnlyColumn(c)) return true;
  if (dbType !== "sqlite") return false;
  return c.key === "PRI" && /^integer$/i.test(c.colType.trim());
}

/** 値を入れなくてよい列か (NULL可・既定値あり・DBが値を作る) */
function optional(c: ColumnInfo, dbType: DbType): boolean {
  if (c.nullable) return true;
  // 空文字も既定値のひとつ ("" を「既定値なし」と見ない)
  if (c.default !== undefined && c.default !== null) return true;
  return generated(c, dbType);
}

/** 割り当てを確かめる (実行前の確認用) */
export function checkMapping(
  mapping: (string | null)[],
  columns: ColumnInfo[],
  mode: ImportMode,
  dbType: DbType
): MappingIssue[] {
  const issues: MappingIssue[] = [];
  const picked = mapping.filter((m): m is string => m !== null);
  if (picked.length === 0) {
    issues.push({
      level: "error",
      message: "取り込む列を1つ以上選んでください",
    });
    return issues;
  }

  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const name of picked) {
    if (seen.has(name)) dup.add(name);
    seen.add(name);
  }
  if (dup.size > 0) {
    issues.push({
      level: "error",
      message: `同じ列を2回選んでいます: ${[...dup].join(", ")}`,
    });
  }

  const missing = columns
    .filter((c) => !optional(c, dbType) && !seen.has(c.name))
    .map((c) => c.name);
  if (missing.length > 0) {
    issues.push({
      level: "warn",
      message: `値が必須の列が未選択です: ${missing.join(", ")}`,
    });
  }

  /*
   * GENERATED ALWAYS AS IDENTITY と生成列は、
   * 値を渡すと必ず失敗するので実行前に止める
   */
  const readOnlyCols = columns
    .filter((c) => seen.has(c.name) && readOnlyColumn(c))
    .map((c) => c.name);
  if (readOnlyCols.length > 0) {
    issues.push({
      level: "error",
      message: `DBが値を決める列には取り込めません: ${readOnlyCols.join(", ")}`,
    });
  }

  if (mode !== "append") {
    const pk = columns.filter((c) => c.key === "PRI").map((c) => c.name);
    const pkMissing = pk.filter((n) => !seen.has(n));
    if (pk.length === 0) {
      issues.push({
        level: "warn",
        message:
          "主キーが無いテーブルです。重複の判定ができず、そのまま追加になる場合があります",
      });
    } else if (pkMissing.length > 0) {
      issues.push({
        level: "warn",
        message: `重複の判定に使う主キーが未選択です: ${pkMissing.join(", ")}`,
      });
    }
  }
  return issues;
}
