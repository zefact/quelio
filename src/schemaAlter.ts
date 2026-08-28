/**
 * スキーマの差分から ALTER 文を組み立てる。
 *
 * 出力は「読んで確かめてから流すもの」で、この画面から実行はしない。
 * 取り消せない操作 (DROP) は行頭に `--` を付けて出し、
 * 意図して外したときだけ実行されるようにしている
 */
import type { ColumnInfo, DbType, IndexInfo, SchemaEntry } from "./types";
import { quoteIdent } from "./tableSql";

/** 消す操作にはコメントを付けて、そのままでは流れないようにする */
const KEEP = "-- ";

/** スキーマ付きのテーブル名 */
function quoteName(dbType: DbType, schema: string | undefined, name: string) {
  const t = quoteIdent(dbType, name);
  return schema && dbType !== "sqlite"
    ? `${quoteIdent(dbType, schema)}.${t}`
    : t;
}

function entryKey(e: SchemaEntry): string {
  const t = e.table;
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

/**
 * そのまま書いてよい (引用しない) デフォルト値。
 *
 * 数値・真偽値・日時関数のほか、BITの `b'1'` と16進の `0x61` を含む。
 * ※ 文字列の "NULL" / "TRUE" は information_schema からは
 *    キーワードと同じ形で返るため区別できず、キーワードとして扱う
 */
const BARE_DEFAULTS =
  /^(NULL|TRUE|FALSE|CURRENT_DATE|CURRENT_TIME|-?\d+(\.\d+)?|0x[0-9a-f]+|b'[01]+')$/i;

/** MySQLで括弧を付けずに書ける日時のデフォルト */
const BARE_TIME_DEFAULTS = /^(CURRENT_TIMESTAMP(\(\d*\))?|NOW\(\))$/i;

/**
 * DEFAULT に書く値。
 *
 * MySQLの information_schema は文字列のデフォルトを引用符なしで返すため、
 * そのまま連結すると `DEFAULT active` という流せないSQLになる。
 * 式として書かれたもの (EXTRA が DEFAULT_GENERATED) は括弧が外れて返るので、
 * 括弧を付け直す (MySQL 8 の式デフォルトは括弧が必須)。
 * PostgreSQL / SQLite は引用済みの式が返るので触らない
 */
function defaultValue(dbType: DbType, c: ColumnInfo): string {
  const raw = c.default ?? "";
  if (dbType !== "mysql") return raw;
  const body = raw.trim();
  if (BARE_TIME_DEFAULTS.test(body)) return raw;
  if ((c.extra ?? "").toUpperCase().includes("DEFAULT_GENERATED")) {
    return `(${body})`;
  }
  if (BARE_DEFAULTS.test(body)) return raw;
  // MariaDB (10.2.7以降) は式として返すため、すでに引用済みのことがある。
  // 二重に囲むと値の中に引用符が入ってしまうのでそのまま出す
  if (body.length >= 2 && body.startsWith("'") && body.endsWith("'")) {
    return raw;
  }
  return sqlString(dbType, raw);
}

/**
 * SQLの文字列リテラル。
 * MySQLは既定でバックスラッシュもエスケープ扱いなので、こちらも重ねる
 */
function sqlString(dbType: DbType, value: string): string {
  const escaped =
    dbType === "mysql"
      ? value.replace(/\\/g, "\\\\").replace(/'/g, "''")
      : value.replace(/'/g, "''");
  return `'${escaped}'`;
}

/** MySQLのEXTRAのうち、定義に書けるものだけ (ddl.rs の mysql_extra と同じ考え方) */
function mysqlExtra(c: ColumnInfo): string {
  const up = (c.extra ?? "").toUpperCase();
  let out = "";
  if (up.includes("ON UPDATE CURRENT_TIMESTAMP")) {
    out += " ON UPDATE CURRENT_TIMESTAMP";
  }
  if (up.includes("AUTO_INCREMENT")) out += " AUTO_INCREMENT";
  return out;
}

/** カラム定義の本体 (型 + NULL可否 + デフォルト + コメント) */
/**
 * PostgreSQLの連番列 (serial) を見分けて、型名に戻す。
 *
 * カタログ上は「integer + DEFAULT nextval('…_seq')」に見えるが、
 * そのまま出すとシーケンスが無くて作れない。
 * `serial` と書けば、シーケンスの作成まで含めてやってくれる
 */
const PG_SERIAL: Record<string, string> = {
  smallint: "smallserial",
  int2: "smallserial",
  integer: "serial",
  int: "serial",
  int4: "serial",
  bigint: "bigserial",
  int8: "bigserial",
};

function pgSerialType(c: ColumnInfo): string | null {
  if (!(c.default ?? "").includes("nextval(")) return null;
  return PG_SERIAL[c.colType.trim().toLowerCase()] ?? null;
}

function columnDef(dbType: DbType, c: ColumnInfo): string {
  if (dbType === "postgresql") {
    // serial は型名だけで「NOT NULL + 既定値」まで含む
    const serial = pgSerialType(c);
    if (serial) return serial;
  }
  let sql = c.colType;
  if (dbType === "mysql" && c.collation) sql += ` COLLATE ${c.collation}`;
  sql += c.nullable ? " NULL" : " NOT NULL";
  // 空文字のデフォルト ('') も指定なしと区別する
  if (c.default != null) sql += ` DEFAULT ${defaultValue(dbType, c)}`;
  if (dbType === "mysql") sql += mysqlExtra(c);
  // MySQLは定義の一部としてコメントを書ける (PostgreSQLは COMMENT ON を別に出す)
  if (dbType === "mysql" && c.comment) {
    sql += ` COMMENT ${sqlString(dbType, c.comment)}`;
  }
  return sql;
}

/** カラムを1本のALTERで書き換えられるか (MySQLだけ) */
function modifyColumn(
  dbType: DbType,
  table: string,
  c: ColumnInfo
): string[] {
  const col = quoteIdent(dbType, c.name);
  if (dbType === "mysql") {
    return [`ALTER TABLE ${table} MODIFY COLUMN ${col} ${columnDef(dbType, c)};`];
  }
  if (dbType === "sqlite") {
    return [
      `${KEEP}SQLiteはカラムの型・NULL可否・デフォルトを後から変えられません`,
      `${KEEP}(テーブルを作り直して移し替える必要があります): ${table}.${c.name}`,
    ];
  }
  // PostgreSQLは変えたい項目ごとに文を分ける
  const out = [
    `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${c.colType};`,
    `ALTER TABLE ${table} ALTER COLUMN ${col} ${
      c.nullable ? "DROP NOT NULL" : "SET NOT NULL"
    };`,
  ];
  out.push(
    c.default != null
      ? `ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT ${defaultValue(dbType, c)};`
      : `ALTER TABLE ${table} ALTER COLUMN ${col} DROP DEFAULT;`
  );
  if (c.comment) {
    out.push(
      `COMMENT ON COLUMN ${table}.${col} IS ${sqlString(dbType, c.comment)};`
    );
  }
  return out;
}

/** ただのカラム名の並びか (式・接頭辞長・部分インデックスは組み立てられない) */
function plainColumns(columns: string): string[] | null {
  const parts = columns.split(",").map((c) => c.trim());
  if (parts.length === 0 || parts.some((c) => c === "")) return null;
  // 括弧・空白・記号が入っていたら、定義を再現できないものとみなす
  if (parts.some((c) => /[()\s'"`]/.test(c))) return null;
  return parts;
}

/**
 * インデックスを作る文 (主キー・UNIQUE制約に紐づくものは対象外)。
 *
 * 式インデックスや接頭辞長・部分インデックスは、画面が持っている
 * 「カラム」の文字列から元の定義を復元できない。
 * 壊れたSQLを出すよりは、そうと分かるコメントを出す
 */
function createIndex(dbType: DbType, table: string, ix: IndexInfo): string[] {
  const parts = plainColumns(ix.columns);
  if (!parts) {
    return [
      `${KEEP}インデックス ${ix.name} は式や条件を含むため、ここでは組み立てません`,
      `${KEEP}(定義: ${ix.columns})`,
    ];
  }
  // MySQLの接頭辞インデックス (col(10)) は長さも書かないと定義が変わる
  const cols = parts
    .map((c, i) => {
      const n = ix.subParts?.[i];
      return n ? `${quoteIdent(dbType, c)}(${n})` : quoteIdent(dbType, c);
    })
    .join(", ");
  const unique = ix.unique ? "UNIQUE " : "";
  return [
    `CREATE ${unique}INDEX ${quoteIdent(dbType, ix.name)} ON ${table} (${cols});`,
  ];
}

/** インデックスを消す文 (MySQLは ALTER TABLE、他は DROP INDEX) */
function dropIndex(dbType: DbType, table: string, name: string): string {
  return dbType === "mysql"
    ? `ALTER TABLE ${table} DROP INDEX ${quoteIdent(dbType, name)};`
    : `DROP INDEX ${quoteIdent(dbType, name)};`;
}

/** 新しく作るテーブルの CREATE 文 (取得済みの定義から組み立てる) */
function createTable(dbType: DbType, e: SchemaEntry): string[] {
  const table = quoteName(dbType, e.table.schema, e.table.name);
  if (e.table.tableType.toUpperCase().includes("VIEW")) {
    return [
      `${KEEP}ビュー ${table} は定義そのものが要るため、ここでは組み立てません`,
      `${KEEP}(テーブル画面の「CREATE 文」から取得してください)`,
    ];
  }
  /*
   * パーティションの子は列を親から引き継ぐので、並べ直さない。
   * `CREATE TABLE 子 PARTITION OF 親 FOR VALUES …` が本来の形
   */
  const partOf = e.table.partitionOf;
  if (partOf) {
    const [parent, bound] = partOf;
    const head = [`CREATE TABLE ${table} PARTITION OF ${parent}`, `    ${bound}`];
    if (e.table.partitionBy) head.push(`    PARTITION BY ${e.table.partitionBy}`);
    return [`${head.join("\n")};`];
  }
  const defs = e.detail.columns.map(
    (c) => `  ${quoteIdent(dbType, c.name)} ${columnDef(dbType, c)}`
  );
  // 主キーは定義の中に書く (インデックスとしては作らない)
  const pk = e.detail.indexes.find((ix) => ix.name.toUpperCase() === "PRIMARY");
  const pkCols = e.detail.columns
    .filter((c) => (c.key ?? "").toUpperCase() === "PRI")
    .map((c) => quoteIdent(dbType, c.name));
  if (pk || pkCols.length > 0) {
    const cols = pk
      ? pk.columns.split(",").map((c) => quoteIdent(dbType, c.trim()))
      : pkCols;
    defs.push(`  PRIMARY KEY (${cols.join(", ")})`);
  }
  // パーティションの親: どう分けるかは列の並びの後ろに書く
  const partBy = e.table.partitionBy ? `\nPARTITION BY ${e.table.partitionBy}` : "";
  const out = [`CREATE TABLE ${table} (\n${defs.join(",\n")}\n)${partBy};`];
  // 主キー以外の制約 (UNIQUE など) は、ここでは組み立てられない
  const constrained = e.detail.indexes.filter(
    (ix) => ix.constrained && ix.name.toUpperCase() !== "PRIMARY"
  );
  if (constrained.length > 0) {
    out.push(
      `${KEEP}制約に紐づくインデックス (${constrained
        .map((ix) => ix.name)
        .join(", ")}) は、ここでは組み立てません`
    );
  }
  for (const ix of e.detail.indexes) {
    if (ix.constrained || ix.name.toUpperCase() === "PRIMARY") continue;
    out.push(...createIndex(dbType, table, ix));
  }
  // PostgreSQLはコメントを別の文で付ける
  if (dbType === "postgresql") {
    for (const c of e.detail.columns) {
      if (!c.comment) continue;
      out.push(
        `COMMENT ON COLUMN ${table}.${quoteIdent(dbType, c.name)} IS ${sqlString(dbType, c.comment)};`
      );
    }
  }
  return out;
}

/** カラムの中身が同じか (比較する項目は差分ビューアと同じ) */
function sameColumn(a: ColumnInfo, b: ColumnInfo): boolean {
  return (
    a.colType === b.colType &&
    a.nullable === b.nullable &&
    a.default === b.default &&
    (a.extra ?? "") === (b.extra ?? "") &&
    (a.collation ?? "") === (b.collation ?? "") &&
    (a.comment ?? "") === (b.comment ?? "")
  );
}

function sameIndex(a: IndexInfo, b: IndexInfo): boolean {
  return (
    a.columns === b.columns &&
    a.unique === b.unique &&
    (a.indexType ?? "") === (b.indexType ?? "") &&
    // 接頭辞の長さが違えば別のインデックス
    JSON.stringify(a.subParts ?? []) === JSON.stringify(b.subParts ?? [])
  );
}

/**
 * 左 (適用先) を右 (お手本) に合わせるためのSQLを組み立てる。
 *
 * dbType は適用先 = 左側のものを使う
 */
export function buildMigration(
  dbType: DbType,
  left: SchemaEntry[],
  right: SchemaEntry[],
  /** 右 (お手本) 側のDB種別。左と違うときは注意書きを出す */
  rightDbType?: DbType
): string {
  const lMap = new Map(left.map((e) => [entryKey(e), e]));
  const rMap = new Map(right.map((e) => [entryKey(e), e]));
  const keys = [...new Set([...lMap.keys(), ...rMap.keys()])].sort();

  const out: string[] = [
    "-- 左 (適用先) を右 (お手本) に合わせるためのSQLです。",
    "-- 内容を確かめてから実行してください。この画面では実行しません。",
    "-- 消す操作は行頭に -- を付けてあります (必要なときだけ外してください)。",
  ];
  if (rightDbType && rightDbType !== dbType) {
    out.push(
      "--",
      `-- ※ 左と右でDBの種類が違います (${dbType} ← ${rightDbType})。`,
      "--    型名や書き方はそのまま移しているので、型は必ず読み替えてください。"
    );
  }

  // ここまでが見出し。1行も足されなければ「差分なし」と出す
  const head = out.length;

  for (const key of keys) {
    const l = lMap.get(key);
    const r = rMap.get(key);
    if (l && !r) {
      const table = quoteName(dbType, l.table.schema, l.table.name);
      const isView = l.table.tableType.toUpperCase().includes("VIEW");
      out.push("", `-- ${key}: 右にはありません`);
      out.push(`${KEEP}DROP ${isView ? "VIEW" : "TABLE"} ${table};`);
      continue;
    }
    if (!l && r) {
      out.push("", `-- ${key}: 左にはありません`);
      out.push(...createTable(dbType, r));
      continue;
    }
    if (!l || !r) continue;

    const table = quoteName(dbType, l.table.schema, l.table.name);
    const body: string[] = [];

    const lCols = new Map(l.detail.columns.map((c) => [c.name, c]));
    const rCols = new Map(r.detail.columns.map((c) => [c.name, c]));
    for (const [name, c] of rCols) {
      const cur = lCols.get(name);
      if (!cur) {
        body.push(
          `ALTER TABLE ${table} ADD COLUMN ${quoteIdent(dbType, name)} ${columnDef(dbType, c)};`
        );
      } else if (!sameColumn(cur, c)) {
        body.push(...modifyColumn(dbType, table, c));
      }
    }
    for (const name of lCols.keys()) {
      if (rCols.has(name)) continue;
      body.push(
        `${KEEP}ALTER TABLE ${table} DROP COLUMN ${quoteIdent(dbType, name)};`
      );
    }

    const lIx = new Map(
      l.detail.indexes.filter((ix) => !ix.constrained).map((ix) => [ix.name, ix])
    );
    const rIx = new Map(
      r.detail.indexes.filter((ix) => !ix.constrained).map((ix) => [ix.name, ix])
    );
    for (const [name, ix] of rIx) {
      const cur = lIx.get(name);
      if (!cur) {
        body.push(...createIndex(dbType, table, ix));
      } else if (!sameIndex(cur, ix)) {
        const created = createIndex(dbType, table, ix);
        const buildable = created.every((line) => !line.startsWith(KEEP));
        // 作り直しになるので、消す側とセットでコメントにしてある
        // (片方だけ流すと元に戻せなくなるため)
        body.push(
          buildable
            ? `${KEEP}${name} は作り直しになります (下の2行をセットで外してください)`
            : `${KEEP}${name} は中身が変わっていますが、定義を組み立てられません`
        );
        body.push(`${KEEP}${dropIndex(dbType, table, name)}`);
        for (const line of created) {
          body.push(line.startsWith(KEEP) ? line : `${KEEP}${line}`);
        }
      }
    }
    for (const name of lIx.keys()) {
      if (rIx.has(name)) continue;
      body.push(`${KEEP}${dropIndex(dbType, table, name)}`);
    }

    if (body.length > 0) {
      out.push("", `-- ${key}`);
      out.push(...body);
    }
  }

  if (out.length === head) out.push("", "-- 差分はありません");
  return out.join("\n");
}
