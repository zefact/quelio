/**
 * 列ごとの絞り込みの決まりごと。
 *
 * 絞る中身そのものはRust側が持っているので、
 * ここにあるのは「画面で組み立てたものを、渡す形に直す」だけ。
 * 画面の作りとは切り離してあるので、決め方だけを試せる
 */
import type {
  CsvColumnFilter,
  CsvFilterKind,
  CsvFilterRule,
  CsvFilterValue,
} from "../../types";

/** 条件の種類と、画面に出す言い方 (出す順に並べてある) */
export const KINDS: { kind: CsvFilterKind; label: string }[] = [
  { kind: "contains", label: "を含む" },
  { kind: "notContains", label: "を含まない" },
  { kind: "equals", label: "と等しい" },
  { kind: "notEquals", label: "と等しくない" },
  { kind: "startsWith", label: "で始まる" },
  { kind: "endsWith", label: "で終わる" },
  { kind: "gt", label: "より大きい" },
  { kind: "ge", label: "以上" },
  { kind: "lt", label: "より小さい" },
  { kind: "le", label: "以下" },
  { kind: "empty", label: "が空" },
  { kind: "notEmpty", label: "が空でない" },
];

/** 値を書く欄が要る条件か */
export function needsValue(kind: CsvFilterKind): boolean {
  return kind !== "empty" && kind !== "notEmpty";
}

/** 中身の無い (絞っていないのと同じ) 絞り込みか */
export function isBlank(f: CsvColumnFilter): boolean {
  return f.values === null && f.rules.length === 0;
}

/** その列の絞り込み (掛かっていなければ undefined) */
export function filterOf(
  filters: CsvColumnFilter[],
  col: number
): CsvColumnFilter | undefined {
  return filters.find((f) => f.col === col);
}

/** その列に絞り込みが掛かっているか */
export function isFiltered(filters: CsvColumnFilter[], col: number): boolean {
  const f = filterOf(filters, col);
  return !!f && !isBlank(f);
}

/**
 * 1つの列の絞り込みを入れ替えた一覧を作る。
 *
 * 中身が無くなったものは持たない (絞っていないのと同じなので)
 */
export function withFilter(
  filters: CsvColumnFilter[],
  next: CsvColumnFilter
): CsvColumnFilter[] {
  const rest = filters.filter((f) => f.col !== next.col);
  if (isBlank(next)) return rest;
  return [...rest, next].sort((a, b) => a.col - b.col);
}

/**
 * 値の一覧から、打ち込んだ字を含むものだけを取り出す。
 *
 * 英字の大小は区別しない (探すときと同じ扱いにする)
 */
export function matching(
  values: CsvFilterValue[],
  text: string
): CsvFilterValue[] {
  const q = text.trim().toLowerCase();
  if (!q) return values;
  return values.filter((v) => v.text.toLowerCase().includes(q));
}

/**
 * 選んだ値を、渡す形に直す。
 *
 * 全部選んでいるときは `null` (値では絞らない) にする。
 * そうしないと、あとで行が増えたときに新しい値が消えてしまう
 */
export function pickedValues(
  all: CsvFilterValue[],
  picked: Set<string>
): string[] | null {
  const list = all.filter((v) => picked.has(v.text)).map((v) => v.text);
  if (list.length === all.length) return null;
  return list;
}

/** 書きかけの条件のうち、渡せるものだけ */
export function usableRules(rules: CsvFilterRule[]): CsvFilterRule[] {
  return rules.filter((r) => !needsValue(r.kind) || r.value !== "");
}

/**
 * 絞り込みの中身を短い言葉にする (見出しの吹き出しに出す)。
 *
 * 値と条件の両方を掛けているときは、両方を並べる
 */
export function filterLabel(f: CsvColumnFilter | undefined): string {
  if (!f || isBlank(f)) return "この列で絞り込む";
  const parts: string[] = [];
  if (f.values) parts.push(`${f.values.length.toLocaleString()}個の値`);
  for (const r of f.rules) {
    const label = KINDS.find((k) => k.kind === r.kind)?.label ?? "";
    parts.push(needsValue(r.kind) ? `「${r.value}」${label}` : label);
  }
  return `${parts.join(f.all ? " かつ " : " または ")} で絞り込み中`;
}
