/**
 * SQLエディタの入力補完。
 *
 * 書いている場所を見て候補を絞り込む。
 *  - `FROM` / `JOIN` / `INTO` / `UPDATE` / `TABLE` の直後 → テーブル名だけ
 *  - `別名.` や `テーブル名.` の直後 → その取得元のカラムだけ
 *  - 文中で取得元が特定できている → そのカラムだけ
 *  - それ以外 → テーブル名だけ
 *
 * 「取得元」には実テーブルだけでなく、WITH句と導出表 (`FROM (...) x`) も入る。
 * どこから何が見えるかの割り出しは sqlScope に任せ、
 * ここは「見えているものをどう候補にするか」だけを持つ。
 *
 * 予約語や関数名は候補に出さない (テーブル・カラムだけを出す)
 */
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { scopeAt } from "./sqlScope";
import type { ScopeSource } from "./sqlScope";
import { ID_SOURCE, unquote } from "./sqlText";
/** 補完に出すカラム1件 */
export interface CompletionColumn {
  name: string;
  /** コメントから取り出した日本語名 (無ければ空) */
  logical: string;
  /** 型名 (無ければ空) */
  dataType: string;
  /** 主キーの一部か (候補に「PK」と出す) */
  pk: boolean;
}

/** 補完に出すテーブル1件 */
export interface CompletionTable {
  /** コメントから取り出した日本語名 (無ければ空) */
  logical: string;
  columns: CompletionColumn[];
}

/** "テーブル名" → テーブルの情報 */
export type SchemaMap = Record<string, CompletionTable>;

/** 候補の2列目以降 (主キーの印 / テーブル名 / 日本語名 / 型) */
export type Cells = [string, string, string, string];

/** 表示用の列を持たせた候補 */
export type SqlOption = Completion & { cells?: Cells };

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
 * 候補を「名前 / PK / テーブル名 / 日本語名 / 型」の5列で表示する。
 * autocompletion() の addToOptions に渡す (名前の列は標準の描画のまま)。
 *
 * PKの列は中身が無くても作る (幅はCSSで固定してあり、
 * 行によって出したり消したりすると右の列がずれるため)
 */
export const completionCells = [
  cell(0, "ac-pk", 55),
  cell(1, "ac-table", 60),
  cell(2, "ac-logical", 70),
  cell(3, "ac-type", 80, true),
];

/**
 * 定義順を保つための重み。
 *
 * CodeMirrorは点数が同じ候補をa→z順に並べ替えてしまうので、
 * 先に定義されたカラムほど高い重みを付けて元の並びに戻す。
 * 幅を±99に収めるのは、絞り込みの一致度 (100点刻み) を
 * 追い越して「関係ない候補が上に来る」のを防ぐため
 */
const BOOST_SPAN = 99;

/** index番目 (全total件) の重み */
export function orderBoost(index: number, total: number): number {
  if (total <= 1) return BOOST_SPAN;
  const at = Math.min(Math.max(index, 0), total - 1);
  return BOOST_SPAN - (at * BOOST_SPAN * 2) / (total - 1);
}

/** 並べた順を保つ重みを付ける (組み立てた並びがそのまま候補の並びになる) */
export function keepOrder<T extends Completion>(
  options: T[]
): (T & { boost: number })[] {
  return options.map((o, at) => ({
    ...o,
    boost: orderBoost(at, options.length),
  }));
}

/** スキーマ付きの識別子 */
const QUALIFIED = `${ID_SOURCE}(?:\\s*\\.\\s*${ID_SOURCE})*`;
/** テーブル名を書く場所を示すキーワード */
const TABLE_KEYWORDS = "from|join|into|update|table";

/** `FROM t1, ` のように、テーブル名を書く位置にいるか */
export const TABLE_POS = new RegExp(
  `\\b(?:${TABLE_KEYWORDS})\\s+(?:${QUALIFIED}(?:\\s+(?:as\\s+)?${ID_SOURCE})?\\s*,\\s*)*$`,
  "i"
);
/** `別名.` の直前までを取り出す */
export const QUALIFIER = new RegExp(
  `(?:(${ID_SOURCE})\\s*\\.\\s*)?(${ID_SOURCE})\\s*\\.\\s*$`
);

/** カーソルの居る文 (`;` 区切り) の範囲 */
function statementRange(doc: string, pos: number): [number, number] {
  const start = doc.lastIndexOf(";", pos - 1) + 1;
  const end = doc.indexOf(";", pos);
  return [start, end < 0 ? doc.length : end];
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
    cells: ["", "table", schema[key]?.logical ?? "", ""],
  };
}

/**
 * カラム名の候補 (名前の右にPK・テーブル名・日本語名・型をこの順で出す)。
 * 並びはテーブルの定義順のまま出す (a→z順に直されないよう重みを付ける)
 */
function columnOptions(schema: SchemaMap, table: string): SqlOption[] {
  const columns = schema[table]?.columns ?? [];
  return columns.map((c) => ({
    label: c.name,
    type: "property",
    cells: [c.pk ? "PK" : "", table, c.logical, c.dataType],
  }));
}

/**
 * WITH句・導出表が返す列の候補。
 *
 * 実テーブルと違って型やコメントが分からないので、
 * 出せるのは名前と「どこから来たか」だけになる
 */
function derivedOptions(columns: string[], from: string): SqlOption[] {
  return columns.map((name) => ({
    label: name,
    type: "property",
    cells: ["", from, "", ""],
  }));
}

/** WITH句で定義された名前の候補 (テーブル名と並べて出す) */
function cteOption(name: string): SqlOption {
  return { label: name, type: "type", cells: ["", "with", "", ""] };
}

/** その取得元のカラム候補 (実テーブルならスキーマから、そうでなければ割り出した列) */
function sourceOptions(schema: SchemaMap, s: ScopeSource): Completion[] {
  if (s.table) {
    const key = findTable(schema, s.table);
    if (key) return columnOptions(schema, key);
  }
  if (s.columns) return derivedOptions(s.columns, s.alias || "副問い合わせ");
  return [];
}

/**
 * 名前 (別名またはテーブル名) から取得元を探す。
 *
 * 別名を付けてあるときは、その別名でしか呼べない
 * (`FROM users u` に対する `users.id` はSQLとして誤り) のでそれに倣う
 */
function findSource(sources: ScopeSource[], name: string): ScopeSource | null {
  const lower = name.toLowerCase();
  const byAlias = sources.find((s) => s.alias.toLowerCase() === lower);
  if (byAlias) return byAlias;
  return (
    sources.find((s) => {
      if (s.alias || !s.table) return false;
      const t = s.table.toLowerCase();
      return t === lower || (t.split(".").pop() ?? "") === lower;
    }) ?? null
  );
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
    // 今いる場所から何が見えるか (WITH句・導出表・副問い合わせを含む)
    const scope = scopeAt(statement, context.pos - stmtFrom, (name) => {
      const key = findTable(schema, name);
      return key ? schema[key].columns.map((c) => c.name) : null;
    });
    /*
     * 候補を返す。
     * 並びはここで作った順 (テーブルの定義順) を保つ
     */
    const done = (options: Completion[]): CompletionResult | null =>
      options.length === 0
        ? null
        : { from, options: keepOrder(options), validFor: /^[\w$#]*$/ };

    // 1. `別名.` / `テーブル名.` の直後 → その取得元のカラムだけ
    const qualifier = QUALIFIER.exec(before);
    if (qualifier) {
      const name = unquote(qualifier[2]);
      const prefix = qualifier[1] ? unquote(qualifier[1]) : "";
      if (!prefix) {
        // 書いている場所から見えているもの (WITH句・導出表を含む) を先に見る
        const src = findSource(scope.sources, name);
        if (src) {
          const options = sourceOptions(schema, src);
          if (options.length > 0) return done(options);
        }
      }
      const key =
        findTable(schema, prefix ? `${prefix}.${name}` : name) ??
        findTable(schema, name);
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

    // 2. テーブル名を書く場所 → テーブル名 (WITH句の名前を先に出す)
    if (TABLE_POS.test(before)) {
      return done([...scope.cteNames.map(cteOption), ...tableOptions(schema)]);
    }

    if (!context.explicit && (!word || word.from === word.to)) return null;

    // 3. 見えている取得元があれば、そのカラムだけ
    const seen = new Set<string>();
    const columns: Completion[] = [];
    for (const src of scope.sources) {
      for (const option of sourceOptions(schema, src)) {
        const id = `${src.alias}.${src.table}.${option.label}`;
        if (seen.has(id)) continue;
        seen.add(id);
        columns.push(option);
      }
    }
    if (columns.length > 0) return done(columns);

    // 4. 手掛かりが無ければテーブル名
    return done([...scope.cteNames.map(cteOption), ...tableOptions(schema)]);
  };
}
