/**
 * テーブル作成画面の入力の持ち方と、送る形への組み立て。
 *
 * 画面から切り離しておき、ここだけをテストする。
 * 最終的な可否はバックエンド (ddl_table.rs) が決めるので、
 * ここでは「作る前に画面で気づけること」だけを見る
 */
import type { ColumnSpec, DbType, NewTableSpec } from "../../types";

/** 入力中の1カラム */
export interface DraftColumn {
  /** 行のキー (名前は編集中に変わるのでキーには使えない) */
  id: string;
  name: string;
  /** 型名 (候補から選ぶ) */
  type: string;
  /** 括弧の中身 (長さ・精度・列挙の値)。空なら括弧を付けない */
  args: string;
  nullable: boolean;
  primaryKey: boolean;
  /** 自動採番 (MySQL: AUTO_INCREMENT / PostgreSQL: serial / SQLite: AUTOINCREMENT) */
  autoIncrement: boolean;
  /** デフォルト値の式 (そのままSQLへ入る) */
  default: string;
  comment: string;
}

/** 行のキー用の通し番号 */
let seq = 0;

/** 空の1行を作る */
export function newColumn(patch: Partial<DraftColumn> = {}): DraftColumn {
  seq += 1;
  return {
    id: `col${seq}`,
    name: "",
    type: "",
    args: "",
    nullable: true,
    primaryKey: false,
    autoIncrement: false,
    default: "",
    comment: "",
    ...patch,
  };
}

/** そのDBでの整数型の書き方 (最初の1行の既定に使う) */
export function intType(dbType: DbType): string {
  return dbType === "mysql" ? "int" : "integer";
}

/** 画面を開いたときに出しておく行 (主キーの id と、空の1行) */
export function firstColumns(dbType: DbType): DraftColumn[] {
  return [
    newColumn({
      name: "id",
      type: intType(dbType),
      nullable: false,
      primaryKey: true,
      autoIncrement: true,
    }),
    newColumn(),
  ];
}

/** 型名と括弧の中身を1つの型にまとめる (varchar + 100 → varchar(100)) */
export function columnType(c: DraftColumn): string {
  const t = c.type.trim();
  const a = c.args.trim();
  return a ? `${t}(${a})` : t;
}

/** バックエンドに渡す1カラムの形にする */
export function toSpec(c: DraftColumn): ColumnSpec {
  return {
    name: c.name.trim(),
    colType: columnType(c),
    nullable: c.nullable,
    default: c.default.trim() || undefined,
    comment: c.comment.trim() || undefined,
    // 自動採番はEXTRAとして送る (カラム変更と同じ持ち方にそろえる)
    extra: c.autoIncrement ? "auto_increment" : undefined,
  };
}

/** 作成の指定をまとめる */
export function toNewTable(v: {
  schema?: string;
  name: string;
  columns: DraftColumn[];
  charset?: string;
  collation?: string;
  comment?: string;
}): NewTableSpec {
  const rows = v.columns.filter((c) => !isEmptyRow(c));
  return {
    schema: v.schema?.trim() || undefined,
    name: v.name.trim(),
    columns: rows.map(toSpec),
    primaryKey: rows.filter((c) => c.primaryKey).map((c) => c.name.trim()),
    charset: v.charset?.trim() || undefined,
    collation: v.collation?.trim() || undefined,
    comment: v.comment?.trim() || undefined,
  };
}

/** 何も入っていない行 (末尾の入力待ちの行) は無いものとして扱う */
export function isEmptyRow(c: DraftColumn): boolean {
  return !c.name.trim() && !c.type.trim() && !c.default.trim() && !c.comment.trim();
}

/**
 * 作る前に画面で止められることを見る。
 * 問題があればその文言、無ければ null
 */
export function validateDraft(
  name: string,
  columns: DraftColumn[]
): string | null {
  if (!name.trim()) return "テーブル名を入力してください";
  const rows = columns.filter((c) => !isEmptyRow(c));
  if (rows.length === 0) return "カラムを1つ以上入れてください";
  for (const c of rows) {
    if (!c.name.trim()) return "カラム名の空いている行があります";
    if (!c.type.trim()) return `型を選んでください: ${c.name.trim()}`;
  }
  const seen = new Set<string>();
  for (const c of rows) {
    const key = c.name.trim().toLowerCase();
    if (seen.has(key)) return `カラム名が重複しています: ${c.name.trim()}`;
    seen.add(key);
  }
  return null;
}

/** 行を上下に動かす (端では動かさない) */
export function moveColumn(
  columns: DraftColumn[],
  index: number,
  dir: -1 | 1
): DraftColumn[] {
  const to = index + dir;
  if (index < 0 || index >= columns.length || to < 0 || to >= columns.length) {
    return columns;
  }
  const next = [...columns];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/**
 * 1行分の入力を変える。
 *
 * 主キーはNULLを許さない、自動採番は主キーでないと作れない、という
 * DB側の決まりに合わせて、関係するチェックも一緒に動かす
 */
export function patchColumn(
  columns: DraftColumn[],
  id: string,
  patch: Partial<DraftColumn>
): DraftColumn[] {
  return columns.map((c) => {
    if (c.id !== id) return c;
    const next = { ...c, ...patch };
    if (patch.autoIncrement === true) {
      next.primaryKey = true;
      next.nullable = false;
    }
    if (patch.primaryKey === true) next.nullable = false;
    // 主キーを外したら、そこに乗っていた自動採番も外す
    if (patch.primaryKey === false) next.autoIncrement = false;
    if (patch.nullable === true) {
      next.primaryKey = false;
      next.autoIncrement = false;
    }
    return next;
  });
}
