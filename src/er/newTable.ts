/**
 * 図の上だけに置くテーブル (設計メモ) の作り方。
 *
 * DBには作らない。リバースしても消えないよう、
 * 読み込んだスキーマと同じ形 (SchemaEntry) にして図の中身へ混ぜる。
 * 日本語名はコメントとして持たせるので、DBから読んだものと同じに描ける
 */
import { parseComment } from "../comment";
import type { SchemaEntry } from "../types";

/** 図に置くテーブルの1列 */
export interface ErTableColumn {
  name: string;
  /** 型 (空でもよい。書かなければ型を出さない) */
  type: string;
  /** 日本語名 (カラムコメントの論理名) */
  logical: string;
  pk: boolean;
  notNull: boolean;
}

/** 図に置くテーブル1つ */
export interface ErTableSpec {
  name: string;
  /** 日本語名 (テーブルコメントの論理名) */
  logical: string;
  columns: ErTableColumn[];
}

/** 空の列 */
export function emptyErColumn(): ErTableColumn {
  return { name: "", type: "", logical: "", pk: false, notNull: false };
}

/** 何も入っていないテーブル (行を1つだけ出しておく) */
export function emptyErTable(): ErTableSpec {
  return { name: "", logical: "", columns: [emptyErColumn()] };
}

/**
 * 入れた内容を確かめる。
 *
 * 問題があればその文言を返す (無ければ null)。
 * `taken` は図にすでにあるテーブル名 (編集のときは自分の名前を除いて渡す)
 */
export function checkErTable(
  spec: ErTableSpec,
  taken: string[]
): string | null {
  const name = spec.name.trim();
  if (!name) return "テーブル名を入れてください";
  const lower = name.toLowerCase();
  if (taken.some((t) => t.toLowerCase() === lower)) {
    return `「${name}」はもう図にあります`;
  }
  const cols = spec.columns.filter((c) => c.name.trim() !== "");
  if (cols.length === 0) return "列を1つ以上入れてください";
  const names = cols.map((c) => c.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) {
    return "同じ名前の列があります";
  }
  return null;
}

/**
 * 入れた内容を、読み込んだスキーマと同じ形にする。
 *
 * 名前が空の列は入れない (入力欄を余分に出しているため)
 */
export function toSchemaEntry(spec: ErTableSpec): SchemaEntry {
  const columns = spec.columns
    .filter((c) => c.name.trim() !== "")
    .map((c) => ({
      name: c.name.trim(),
      colType: c.type.trim(),
      nullable: !c.notNull && !c.pk,
      // 図では key === "PRI" を主キーの印にしている
      key: c.pk ? "PRI" : "",
      comment: c.logical.trim(),
    }));
  return {
    table: { name: spec.name.trim(), tableType: "BASE TABLE" },
    detail: {
      columns,
      indexes: [],
      foreignKeys: [],
      info: spec.logical.trim() ? [["コメント", spec.logical.trim()]] : [],
    },
  };
}

/** 図にあるテーブルを、もう一度入れ直せる形へ戻す */
export function fromSchemaEntry(
  entry: SchemaEntry,
  delim: string
): ErTableSpec {
  const comment =
    entry.detail.info.find(([label]) => label === "コメント")?.[1] ?? "";
  return {
    name: entry.table.name,
    logical: parseComment(comment, delim)[0],
    columns: entry.detail.columns.map((c) => ({
      name: c.name,
      type: c.colType,
      logical: parseComment(c.comment ?? "", delim)[0],
      pk: c.key === "PRI",
      notNull: !c.nullable,
    })),
  };
}
