/**
 * SQLエディタの入力補完。
 *
 * 書いている場所を見て候補を絞り込む。
 *  - `FROM` / `JOIN` / `INTO` / `UPDATE` / `TABLE` の直後 → テーブル名だけ
 *  - `別名.` や `テーブル名.` の直後 → そのテーブルのカラムだけ
 *  - 文中でテーブルが特定できている → そのテーブルのカラムだけ
 *  - それ以外 → テーブル名だけ
 *
 * 予約語や関数名は候補に出さない (テーブル・カラムだけを出す)
 */
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
/** 補完に出すカラム1件 */
export interface CompletionColumn {
  name: string;
  /** コメントから取り出した日本語名 (無ければ空) */
  logical: string;
  /** 型名 (無ければ空) */
  dataType: string;
}

/** 補完に出すテーブル1件 */
export interface CompletionTable {
  /** コメントから取り出した日本語名 (無ければ空) */
  logical: string;
  columns: CompletionColumn[];
}

/** "テーブル名" → テーブルの情報 */
export type SchemaMap = Record<string, CompletionTable>;

/** 候補の2列目以降 (テーブル名 / 日本語名 / 型) */
type Cells = [string, string, string];

/** 表示用の列を持たせた候補 */
type SqlOption = Completion & { cells?: Cells };

/**
 * 候補の1列分を描画する。
 * 中身が無くても列は作って縦を揃えるが、最後の列 (型) だけは
 * 空なら作らない (テーブルの候補で右側が無駄に空くのを防ぐ)
 */
function cell(index: number, className: string, position: number, last = false) {
  return {
    position,
    render(completion: Completion): Node | null {
      const text = (completion as SqlOption).cells?.[index] ?? "";
      if (last && !text) return null;
      const span = document.createElement("span");
      span.className = `cm-completionCell ${className}`;
      span.textContent = text;
      // 幅で切れたときのために全文をツールチップで出す
      if (text) span.title = text;
      return span;
    },
  };
}

/**
 * 候補を「名前 / テーブル名 / 日本語名 / 型」の4列で表示する。
 * autocompletion() の addToOptions に渡す (名前の列は標準の描画のまま)
 */
export const completionCells = [
  cell(0, "ac-table", 60),
  cell(1, "ac-logical", 70),
  cell(2, "ac-type", 80, true),
];

/** 識別子 (バッククォート・ダブルクォート囲みも許す) */
const ID = '(?:[A-Za-z_$#][\\w$#]*|`[^`]*`|"[^"]*")';
/** スキーマ付きの識別子 */
const QUALIFIED = `${ID}(?:\\s*\\.\\s*${ID})*`;
/** テーブル名を書く場所を示すキーワード */
const TABLE_KEYWORDS = "from|join|into|update|table";

/** 別名として扱わない語 (`FROM users WHERE` の WHERE などを別名にしないため) */
const NOT_ALIAS = new Set([
  "on", "where", "set", "group", "order", "having", "limit", "offset",
  "join", "inner", "left", "right", "full", "cross", "outer", "natural",
  "using", "values", "select", "union", "except", "intersect", "and", "or",
  "window", "returning", "for", "lateral", "fetch", "partition", "add",
  "drop", "modify", "change", "rename", "alter", "if", "not", "exists",
]);
const NOT_ALIAS_ALT = [...NOT_ALIAS].join("|");

/** `FROM t1, ` のように、テーブル名を書く位置にいるか */
const TABLE_POS = new RegExp(
  `\\b(?:${TABLE_KEYWORDS})\\s+(?:${QUALIFIED}(?:\\s+(?:as\\s+)?${ID})?\\s*,\\s*)*$`,
  "i"
);
/** `別名.` の直前までを取り出す */
const QUALIFIER = new RegExp(`(?:(${ID})\\s*\\.\\s*)?(${ID})\\s*\\.\\s*$`);
/** 文中のテーブルと別名を拾う (別名の位置に予約語が来たら別名なしとみなす) */
const SOURCES = new RegExp(
  `\\b(?:${TABLE_KEYWORDS})\\s+(${QUALIFIED})` +
    `(?:\\s+(?:as\\s+)?(?!(?:${NOT_ALIAS_ALT})\\b)(${ID}))?`,
  "gi"
);

/** クォートを外す */
function unquote(name: string): string {
  const s = name.trim();
  const q = s[0];
  if ((q === "`" || q === '"') && s.length >= 2 && s.endsWith(q)) {
    return s.slice(1, -1);
  }
  return s;
}

/** カーソルの居る文 (`;` 区切り) の範囲 */
function statementRange(doc: string, pos: number): [number, number] {
  const start = doc.lastIndexOf(";", pos - 1) + 1;
  const end = doc.indexOf(";", pos);
  return [start, end < 0 ? doc.length : end];
}

/** 文中に出てくるテーブルと別名を集める */
function collectSources(statement: string): {
  tables: string[];
  aliases: Map<string, string>;
} {
  const tables: string[] = [];
  const aliases = new Map<string, string>();
  SOURCES.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SOURCES.exec(statement))) {
    const table = unquote(m[1]);
    if (!tables.includes(table)) tables.push(table);
    const alias = m[2] ? unquote(m[2]) : "";
    if (alias && !NOT_ALIAS.has(alias.toLowerCase())) {
      aliases.set(alias.toLowerCase(), table);
    }
  }
  return { tables, aliases };
}

/** 名前からスキーマのキーを探す (大文字小文字とスキーマ名の有無を吸収) */
function findTable(schema: SchemaMap, name: string): string | null {
  const keys = Object.keys(schema);
  const lower = name.toLowerCase();
  const exact = keys.find((k) => k.toLowerCase() === lower);
  if (exact) return exact;
  const bare = lower.split(".").pop() ?? lower;
  return (
    keys.find(
      (k) =>
        k.toLowerCase() === bare ||
        (k.toLowerCase().split(".").pop() ?? "") === bare
    ) ?? null
  );
}

/** テーブル名の候補 (`schema.table` と重複する短い名前は片方だけ出す) */
function tableOptions(schema: SchemaMap): Completion[] {
  const keys = Object.keys(schema);
  const bare = new Set(
    keys.filter((k) => !k.includes(".")).map((k) => k.toLowerCase())
  );
  return keys
    .filter(
      (k) => !k.includes(".") || !bare.has(k.split(".").pop()!.toLowerCase())
    )
    .map((label) => tableOption(label, label, schema));
}

/** テーブル1件の候補 (表示は「テーブル名 / table / 日本語名」) */
function tableOption(
  label: string,
  key: string,
  schema: SchemaMap
): SqlOption {
  return {
    label,
    type: "type",
    cells: ["table", schema[key]?.logical ?? "", ""],
  };
}

/** カラム名の候補 (名前の右にテーブル名・日本語名・型をこの順で出す) */
function columnOptions(schema: SchemaMap, table: string): SqlOption[] {
  return (schema[table]?.columns ?? []).map((c) => ({
    label: c.name,
    type: "property",
    cells: [table, c.logical, c.dataType],
  }));
}

/** 補完候補を作る (スキーマは都度読むので、接続先が変わっても作り直し不要) */
export function sqlCompletion(getSchema: () => SchemaMap): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const schema = getSchema();
    const word = context.matchBefore(/[\w$#]*/);
    const from = word ? word.from : context.pos;
    const doc = context.state.doc.toString();
    const [stmtFrom, stmtTo] = statementRange(doc, context.pos);
    const before = doc.slice(stmtFrom, from);
    const statement = doc.slice(stmtFrom, stmtTo);
    const { tables, aliases } = collectSources(statement);
    const done = (options: Completion[]): CompletionResult | null =>
      options.length === 0
        ? null
        : { from, options, validFor: /^[\w$#]*$/ };

    // 1. `別名.` / `テーブル名.` の直後 → そのテーブルのカラムだけ
    const qualifier = QUALIFIER.exec(before);
    if (qualifier) {
      const name = unquote(qualifier[2]);
      const prefix = qualifier[1] ? unquote(qualifier[1]) : "";
      const table = aliases.get(name.toLowerCase()) ?? name;
      const key =
        findTable(schema, prefix ? `${prefix}.${table}` : table) ??
        findTable(schema, table);
      if (key) return done(columnOptions(schema, key));
      if (!prefix) {
        // スキーマ名かもしれないので、その配下のテーブルを出す
        const head = `${name.toLowerCase()}.`;
        return done(
          Object.keys(schema)
            .filter((k) => k.toLowerCase().startsWith(head))
            .map((k) => tableOption(k.slice(head.length), k, schema))
        );
      }
      return null;
    }

    // 2. テーブル名を書く場所 → テーブル名だけ
    if (TABLE_POS.test(before)) return done(tableOptions(schema));

    if (!context.explicit && (!word || word.from === word.to)) return null;

    // 3. テーブルが特定できていれば、そのカラムだけ
    const keys = tables
      .map((t) => findTable(schema, t))
      .filter((k): k is string => k !== null);
    if (keys.length > 0) {
      const seen = new Set<string>();
      const columns: Completion[] = [];
      for (const key of keys) {
        for (const option of columnOptions(schema, key)) {
          const id = `${key}.${option.label}`;
          if (seen.has(id)) continue;
          seen.add(id);
          columns.push(option);
        }
      }
      return done(columns);
    }

    // 4. 手掛かりが無ければテーブル名
    return done(tableOptions(schema));
  };
}
