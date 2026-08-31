/**
 * ER図をテキスト形式 (Mermaid / PlantUML) で書き出す。
 *
 * PNGは貼った後で差分が見えないが、テキストならリポジトリに置いて
 * レビューできる。GitHub・Notion等はMermaidをそのまま描画する。
 *
 * 画面には依存しない純関数だけを置く (テストしやすくするため)
 */
import type { ErEdge, ErNode } from "./model";

export interface ErTextInput {
  /** 見出しに出すデータベース名 */
  database: string;
  nodes: ErNode[];
  edges: ErEdge[];
}

/** そのまま識別子として書ける名前か */
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 表示に使う名前 (日本語名があれば添える) */
function label(n: ErNode): string {
  return n.logical ? `${n.name} (${n.logical})` : n.name;
}

/** 引用符の中に入れる (中の引用符は落とす) */
function quoted(s: string): string {
  return `"${s.replace(/"/g, "")}"`;
}

/**
 * 型の表記。
 * 記号が混ざると形式によっては読めないので、英数字と括弧だけに寄せる
 */
function typeText(t: string): string {
  const s = t.trim().replace(/\s+/g, "_");
  return s === "" ? "unknown" : s.replace(/[^A-Za-z0-9_(),[\]]/g, "_");
}

/** 名前 (カラム名) の表記 */
function nameText(s: string): string {
  return s.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_]/g, "_");
}

/** そのテーブルで、他のテーブルを参照しているカラム */
function fkColumns(edges: ErEdge[], table: string): Set<string> {
  return new Set(
    edges.filter((e) => e.from === table).map((e) => e.fromColumn)
  );
}

/** 参照元のカラムがNOT NULLか (必ず1件あるか、無くてもよいかの判断に使う) */
function required(node: ErNode | undefined, column: string): boolean {
  const c = node?.columns.find((x) => x.name === column);
  return !!c && (c.isPk || c.notNull);
}

/** 書き出す対象のエッジ (両端が図にあるものだけ) */
function usableEdges(v: ErTextInput): ErEdge[] {
  const names = new Set(v.nodes.map((n) => n.name));
  return v.edges.filter((e) => names.has(e.from) && names.has(e.to));
}

/** 見出しに入れる注記 */
function headNote(v: ErTextInput, mark: string): string[] {
  return [
    `${mark} Quelio で書き出したER図 (データベース: ${v.database})`,
    `${mark} 参照は「子テーブル → 親テーブル」。点線は名前から推測した関連です`,
  ];
}

/** Mermaid (erDiagram) 形式 */
export function toMermaid(v: ErTextInput): string {
  const byName = new Map(v.nodes.map((n) => [n.name, n]));
  const edges = usableEdges(v);
  /** 図の中での呼び名 (関連の行でも同じものを使う) */
  const ref = (n: ErNode) => {
    const text = label(n);
    return PLAIN.test(text) ? text : quoted(text);
  };

  const out: string[] = [...headNote(v, "%%"), "erDiagram"];
  for (const n of v.nodes) {
    const fks = fkColumns(edges, n.name);
    out.push(`    ${ref(n)} {`);
    for (const c of n.columns) {
      const keys = [c.isPk ? "PK" : "", fks.has(c.name) ? "FK" : ""]
        .filter(Boolean)
        .join(",");
      const parts = [typeText(c.type), nameText(c.name), keys].filter(Boolean);
      // 日本語名は注記として添える (図にそのまま出る)
      if (c.logical) parts.push(quoted(c.logical));
      out.push(`        ${parts.join(" ")}`);
    }
    out.push("    }");
  }
  for (const e of edges) {
    const line = e.guessed ? ".." : "--";
    // 参照元がNOT NULLなら「1件以上」、そうでなければ「0件以上」
    const many = required(byName.get(e.from), e.fromColumn) ? "}|" : "}o";
    const from = byName.get(e.from);
    const to = byName.get(e.to);
    if (!from || !to) continue;
    out.push(
      `    ${ref(from)} ${many}${line}|| ${ref(to)} : ${quoted(e.label)}`
    );
  }
  return `${out.join("\n")}\n`;
}

/** PlantUML (entity) 形式 */
export function toPlantUml(v: ErTextInput): string {
  const byName = new Map(v.nodes.map((n) => [n.name, n]));
  const edges = usableEdges(v);
  /** 別名 (関連の行で使う。記号を含まない形にそろえる) */
  const alias = new Map(v.nodes.map((n) => [n.name, nameText(n.name)]));

  const out: string[] = [
    "@startuml",
    ...headNote(v, "'"),
    "hide circle",
    "skinparam linetype ortho",
    "",
  ];
  for (const n of v.nodes) {
    const fks = fkColumns(edges, n.name);
    out.push(`entity ${quoted(label(n))} as ${alias.get(n.name)} {`);
    const pk = n.columns.filter((c) => c.isPk);
    const rest = n.columns.filter((c) => !c.isPk);
    const line = (c: (typeof n.columns)[number]) => {
      const mark = c.isPk || c.notNull ? "*" : " ";
      const keys = [c.isPk ? "<<PK>>" : "", fks.has(c.name) ? "<<FK>>" : ""]
        .filter(Boolean)
        .join(" ");
      const note = c.logical ? ` ' ${c.logical}` : "";
      return `  ${mark} ${c.name} : ${c.type || "unknown"}${keys ? ` ${keys}` : ""}${note}`;
    };
    for (const c of pk) out.push(line(c));
    // 主キーとそれ以外を区切る (PlantUMLの作法)
    if (pk.length > 0 && rest.length > 0) out.push("  --");
    for (const c of rest) out.push(line(c));
    out.push("}", "");
  }
  for (const e of edges) {
    const l = e.guessed ? ".." : "--";
    const many = required(byName.get(e.from), e.fromColumn) ? "}|" : "}o";
    out.push(
      `${alias.get(e.from)} ${many}${l}|| ${alias.get(e.to)} : ${quoted(e.label)}`
    );
  }
  out.push("@enduml");
  return `${out.join("\n")}\n`;
}
