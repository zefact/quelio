/**
 * SQLパラメータ (:name / @name) の抽出と値の埋め込み。
 * 文字列リテラル・コメントの中は対象外とし、
 * PostgreSQLのキャスト (::type) やシステム変数 (@@var) は無視する。
 */

const NAME_START = /[A-Za-z_À-￿]/;
const NAME_CHAR = /[A-Za-z0-9_À-￿]/;

/** スキャナ: SQL中のパラメータ出現位置を列挙する */
interface ParamHit {
  /** プレフィックスを含む開始位置 */
  start: number;
  /** 終了位置 (exclusive) */
  end: number;
  /** プレフィックスを除いた名前 */
  name: string;
}

function scan(sql: string): ParamHit[] {
  const hits: ParamHit[] = [];
  let i = 0;
  const n = sql.length;

  const readName = (from: number): number => {
    let j = from;
    while (j < n && NAME_CHAR.test(sql[j])) j++;
    return j;
  };

  while (i < n) {
    const c = sql[i];

    // 文字列リテラル ('...' / "..." / `...`)。'' と \' のエスケープに対応
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (sql[i] === "\\") {
          i += 2;
        } else if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2; // '' のエスケープ
          } else {
            i++;
            break;
          }
        } else {
          i++;
        }
      }
      continue;
    }

    // 行コメント
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "#") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    // ブロックコメント
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }

    // :param (::キャストと := は除外)
    if (c === ":") {
      if (sql[i + 1] === ":" ) {
        i += 2;
        // ::type の型名を読み飛ばす (型名中の文字を誤検出しないように)
        continue;
      }
      if (sql[i + 1] === "=") {
        i += 2;
        continue;
      }
      if (sql[i + 1] && NAME_START.test(sql[i + 1])) {
        const end = readName(i + 1);
        hits.push({ start: i, end, name: sql.slice(i + 1, end) });
        i = end;
        continue;
      }
      i++;
      continue;
    }

    // @param (@@システム変数は除外)
    if (c === "@") {
      if (sql[i + 1] === "@") {
        i += 2;
        const end = readName(i);
        i = end;
        continue;
      }
      if (sql[i + 1] && NAME_START.test(sql[i + 1])) {
        const end = readName(i + 1);
        hits.push({ start: i, end, name: sql.slice(i + 1, end) });
        i = end;
        continue;
      }
      i++;
      continue;
    }

    i++;
  }
  return hits;
}

/** SQLからパラメータ名を出現順 (重複なし) に抽出する */
export function extractParams(sql: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of scan(sql)) {
    if (!seen.has(h.name)) {
      seen.add(h.name);
      out.push(h.name);
    }
  }
  return out;
}

/** パラメータの埋め込み方 */
export type ParamKind = "auto" | "string" | "number" | "raw";

export interface ParamValue {
  value: string;
  kind: ParamKind;
}

export const PARAM_KINDS: [ParamKind, string][] = [
  ["auto", "自動"],
  ["string", "文字列"],
  ["number", "数値"],
  ["raw", "そのまま"],
];

/**
 * SQL中でパラメータと比較されているカラム名を推測する。
 * 例: "u.code = :code" → "code" / ":d <= created_at" → "created_at"
 */
export function guessParamColumn(sql: string, name: string): string | null {
  const id = "[A-Za-z_][A-Za-z0-9_$]*(?:\\.[A-Za-z_][A-Za-z0-9_$]*)*";
  const op = "(?:[=<>!]{1,2}|LIKE|like|Like)";
  const before = new RegExp(`(${id})\\s*${op}\\s*[:@]${name}\\b`);
  const after = new RegExp(`[:@]${name}\\b\\s*${op}\\s*(${id})`);
  const m = sql.match(before) ?? sql.match(after);
  if (!m) return null;
  const parts = m[1].split(".");
  return parts[parts.length - 1];
}

/** カラム型の文字列が数値型かどうか */
export function isNumericType(colType: string): boolean {
  return /int|decimal|numeric|float|double|real|serial|year|bit/i.test(colType);
}
