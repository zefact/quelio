/**
 * 2つのスキーマの差分 (スキーマ差分の画面で使う)。
 *
 * テーブル・カラム・インデックスを名前で突き合わせ、
 * 「左のみ / 右のみ / 差異あり / 一致」に分ける。
 * 一致しているものも結果に残す (画面の「差異のみ表示」を外したときに並べるため)。
 * 画面に依存しない純関数だけを置く
 */
import type { ColumnInfo, IndexInfo, SchemaEntry } from "./types";

/** 値が違っている項目1つ (型・デフォルトなど) */
export interface FieldDiff {
  label: string;
  left?: string;
  right?: string;
}

/** カラム・インデックス1つぶんの比較結果 */
export interface ItemDiff {
  name: string;
  status: "added" | "removed" | "changed" | "same";
  /** 値が違っている項目 (changed のときだけ入る) */
  fields: FieldDiff[];
  /** 左右それぞれの中身のひとこと (カラムは型、インデックスは対象カラム)。無い側は undefined */
  left?: string;
  right?: string;
}

/** テーブル1つぶんの比較結果 */
export interface TableDiff {
  key: string;
  status: "added" | "removed" | "changed" | "same";
  attrs: FieldDiff[];
  /** 一致しているものも含む全カラム (定義の並び順) */
  columns: ItemDiff[];
  /** 一致しているものも含む全インデックス */
  indexes: ItemDiff[];
}

/** 比較する種類 */
export type ItemKind = "columns" | "indexes";

/** テーブルの名前 (スキーマがあれば付ける) */
export function tableKey(e: SchemaEntry): string {
  const t = e.table;
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

/** カラム属性の比較対象 */
function columnFields(c: ColumnInfo): [string, string][] {
  return [
    ["型", c.colType],
    ["NULL許可", c.nullable ? "YES" : "NO"],
    ["キー", c.key ?? ""],
    ["デフォルト", c.default ?? ""],
    ["属性", c.extra ?? ""],
    ["照合順序", c.collation ?? ""],
    ["コメント", c.comment ?? ""],
  ];
}

function indexFields(ix: IndexInfo): [string, string][] {
  return [
    ["カラム", ix.columns],
    ["ユニーク", ix.unique ? "YES" : "NO"],
    ["種別", ix.indexType ?? ""],
  ];
}

/** カラムのひとこと (型) */
function columnSummary(c: ColumnInfo): string {
  return c.colType;
}

/** インデックスのひとこと (対象カラム。ユニークなら印を付ける) */
function indexSummary(ix: IndexInfo): string {
  return ix.unique ? `${ix.columns} (UNIQUE)` : ix.columns;
}

/** テーブル情報のうち比較する項目 (サイズ・行数・日時は除外) */
const TABLE_INFO_LABELS = ["エンジン", "照合順序", "コメント"];

/**
 * 名前で突き合わせて比べる。
 * 並びは左の定義順、そのあとに右だけにあるものを右の定義順で足す
 */
function diffNamedItems<T extends { name: string }>(
  left: T[],
  right: T[],
  fieldsOf: (v: T) => [string, string][],
  summaryOf: (v: T) => string
): ItemDiff[] {
  const rMap = new Map(right.map((v) => [v.name, v]));
  const seen = new Set<string>();
  const out: ItemDiff[] = [];
  for (const l of left) {
    seen.add(l.name);
    const r = rMap.get(l.name);
    if (!r) {
      out.push({ name: l.name, status: "removed", fields: [], left: summaryOf(l) });
      continue;
    }
    const lf = fieldsOf(l);
    const rf = fieldsOf(r);
    const fields: FieldDiff[] = [];
    for (let i = 0; i < lf.length; i++) {
      if (lf[i][1] !== rf[i][1]) {
        fields.push({ label: lf[i][0], left: lf[i][1], right: rf[i][1] });
      }
    }
    out.push({
      name: l.name,
      status: fields.length > 0 ? "changed" : "same",
      fields,
      left: summaryOf(l),
      right: summaryOf(r),
    });
  }
  for (const r of right) {
    if (seen.has(r.name)) continue;
    out.push({ name: r.name, status: "added", fields: [], right: summaryOf(r) });
  }
  return out;
}

/** 差異のあるものだけ (一致を除く) */
export function changedItems(items: ItemDiff[]): ItemDiff[] {
  return items.filter((it) => it.status !== "same");
}

/** 2つのスナップショットの差分を計算する */
export function computeDiff(
  left: SchemaEntry[],
  right: SchemaEntry[]
): TableDiff[] {
  const lMap = new Map(left.map((e) => [tableKey(e), e]));
  const rMap = new Map(right.map((e) => [tableKey(e), e]));
  const keys = [...new Set([...lMap.keys(), ...rMap.keys()])].sort();

  return keys.map((key): TableDiff => {
    const l = lMap.get(key);
    const r = rMap.get(key);
    const columns = diffNamedItems(
      l?.detail.columns ?? [],
      r?.detail.columns ?? [],
      columnFields,
      columnSummary
    );
    const indexes = diffNamedItems(
      l?.detail.indexes ?? [],
      r?.detail.indexes ?? [],
      indexFields,
      indexSummary
    );
    // 片方にしか無いテーブルは、中のカラム・インデックスも全部その側だけになる
    if (!l || !r) {
      return { key, status: l ? "removed" : "added", attrs: [], columns, indexes };
    }

    // テーブル属性
    const attrs: FieldDiff[] = [];
    if (l.table.tableType !== r.table.tableType) {
      attrs.push({
        label: "種別",
        left: l.table.tableType,
        right: r.table.tableType,
      });
    }
    for (const label of TABLE_INFO_LABELS) {
      const lv = l.detail.info.find(([l2]) => l2 === label)?.[1] ?? "";
      const rv = r.detail.info.find(([l2]) => l2 === label)?.[1] ?? "";
      if (lv !== rv) attrs.push({ label, left: lv, right: rv });
    }

    const differs =
      attrs.length +
        changedItems(columns).length +
        changedItems(indexes).length >
      0;
    return { key, status: differs ? "changed" : "same", attrs, columns, indexes };
  });
}

/**
 * そのテーブルで「差異」として数えるカラム・インデックス。
 *
 * 片方にしか無いテーブルの中身は数えない
 * (テーブルごと無いのであって、カラムが1つずつ違うわけではないため。
 *  テーブルのタブに「左のみ / 右のみ」として出る)
 */
export function diffItemsOf(t: TableDiff, kind: ItemKind): ItemDiff[] {
  return t.status === "changed" ? changedItems(t[kind]) : [];
}

/**
 * カラム・インデックスのタブに出すもの。
 *
 * 「差異のみ表示」のときは差異として数えるものだけ、
 * 外したときは一致しているものも、片方にしか無いテーブルの中身も全部
 */
export function itemsToShow(
  t: TableDiff,
  kind: ItemKind,
  onlyDiff: boolean
): ItemDiff[] {
  return onlyDiff ? diffItemsOf(t, kind) : t[kind];
}

/** タブに出す差異の件数 */
export function diffCounts(diff: TableDiff[]): {
  tables: number;
  columns: number;
  indexes: number;
} {
  return {
    tables: diff.filter(
      (t) => t.status === "added" || t.status === "removed" || t.attrs.length > 0
    ).length,
    columns: diff.reduce((n, t) => n + diffItemsOf(t, "columns").length, 0),
    indexes: diff.reduce((n, t) => n + diffItemsOf(t, "indexes").length, 0),
  };
}
