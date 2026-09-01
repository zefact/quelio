/**
 * テーブルの定義まわり。
 * 一覧・カラム・インデックス・外部キーと、それらへの変更指定
 */

export interface TableInfo {
  schema?: string;
  name: string;
  tableType: string;
  rowEstimate?: number;
  /** PostgreSQL: このテーブル自身の分け方 (`RANGE (at)` など) */
  partitionBy?: string | null;
  /** PostgreSQL: パーティションの子なら [親テーブル名 (引用済み), 範囲の指定] */
  partitionOf?: [string, string] | null;
}

export interface ColumnInfo {
  name: string;
  colType: string;
  nullable: boolean;
  key?: string;
  default?: string;
  extra?: string;
  collation?: string;
  comment?: string;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string;
  /** MySQLの接頭辞インデックスの長さ (columns の並びと対応。無ければnull) */
  subParts?: (number | null)[];
  indexType?: string;
  cardinality?: number;
  /** 主キー・UNIQUE制約に紐づくインデックス (画面からは変更できない) */
  constrained: boolean;
}

/** インデックスの追加・変更で指定する内容 */
export interface IndexSpec {
  name: string;
  unique: boolean;
  /** 対象カラム (並び順どおり) */
  columns: string[];
  /** 種別 (空ならDBの既定。MySQL: BTREE/HASH/FULLTEXT/SPATIAL) */
  indexType?: string;
}

/** インデックスに対する変更内容 (バックエンドでSQLに変換する) */
export type IndexChange =
  | { kind: "add"; index: IndexSpec }
  | { kind: "drop"; name: string }
  | { kind: "modify"; before: string; index: IndexSpec };

/** SQLエディタの補完に使うカラム (名前と型) */
export interface SchemaColumn {
  name: string;
  /** 表示用の型名 (取れない場合は空) */
  dataType: string;
  /** カラムコメント (日本語名の取り出しに使う。SQLiteは常に空) */
  comment: string;
  /** 主キーの一部か */
  pk: boolean;
}

/** SQLエディタの補完に使うテーブル */
export interface SchemaTable {
  name: string;
  /** テーブルコメント (日本語名の取り出しに使う。SQLiteは常に空) */
  comment: string;
  columns: SchemaColumn[];
}

export interface TableDetail {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  /** このテーブルから出ている外部キー */
  foreignKeys: ForeignKeyInfo[];
  info: [string, string][];
}

/** スキーマスナップショットの1テーブル分 */
export interface SchemaEntry {
  table: TableInfo;
  detail: TableDetail;
}

/** カラム変更 (DDL) で指定する、変更後 (または追加する) カラムの内容 */
export interface ColumnSpec {
  name: string;
  /** 型 (例: varchar(100)) */
  colType: string;
  nullable: boolean;
  /** デフォルト値の式 (空なら指定なし)。値はそのままSQLへ埋め込まれる */
  default?: string;
  /** カラムコメント (MySQL / PostgreSQLのみ) */
  comment?: string;
  /** 照合順序 (MySQL / PostgreSQLのみ。空ならDBの既定) */
  collation?: string;
  /** MySQLのみ: 位置。"FIRST" で先頭、カラム名ならその直後 */
  after?: string;
  /** MySQLのみ: AUTO_INCREMENT等の属性。変更時に引き継ぐために送る */
  extra?: string;
}

/** 新しく作るテーブルの指定 (バックエンドでCREATE TABLEに変換する) */
export interface NewTableSpec {
  /** スキーマ (PostgreSQLのみ。空なら検索パス任せ) */
  schema?: string;
  name: string;
  columns: ColumnSpec[];
  /** 主キーにするカラム名 (並べた順のまま複合キーになる) */
  primaryKey: string[];
  /** 既定の文字コード (MySQLのみ) */
  charset?: string;
  /** 既定の照合順序 (MySQLのみ) */
  collation?: string;
  /** テーブルコメント (MySQL / PostgreSQLのみ) */
  comment?: string;
}

/** カラムに対する変更内容 (バックエンドでSQLに変換する) */
export type ColumnChange =
  | { kind: "add"; column: ColumnSpec }
  | { kind: "drop"; name: string }
  | { kind: "modify"; before: ColumnSpec; column: ColumnSpec };

/** テーブルに付いている外部キー1件 */
export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  /** 参照先のスキーマ (MySQL・SQLiteは空) */
  refSchema: string;
  refTable: string;
  refColumns: string[];
  /** ON DELETE の動作 (空ならDBの既定) */
  onDelete: string;
  /** ON UPDATE の動作 (空ならDBの既定) */
  onUpdate: string;
}

/** 追加する外部キーの内容 */
export interface ForeignKeySpec {
  /** 制約名 (空ならDBに任せる) */
  name?: string;
  columns: string[];
  /** 参照先のスキーマ (空なら同じスキーマ) */
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

/** 外部キーに対する変更内容 */
export type ForeignKeyChange =
  | { kind: "add"; fk: ForeignKeySpec }
  | { kind: "drop"; name: string };

/** 関数・プロシージャ・トリガ1件 (定義の表示用) */
export interface RoutineInfo {
  /** 種別 (関数 / プロシージャ / トリガ など) */
  kind: string;
  /** スキーマ (MySQL・SQLiteは空) */
  schema: string;
  name: string;
  /** 引数や対象テーブルなどの補足 */
  detail: string;
  /** CREATE文 */
  definition: string;
}

/** 名前で探した結果の1件 */
/** 文字コード1件と、そこで使える照合順序 (バックエンドの CharsetInfo と対) */
export interface CharsetInfo {
  name: string;
  /** 読みやすい説明 (PostgreSQLでは空) */
  description: string;
  /** 何も選ばなかったときに使われる照合順序 (PostgreSQLでは空) */
  defaultCollation: string;
  /** この文字コードで使える照合順序 (PostgreSQLでは空) */
  collations: string[];
}

/** SQLダンプ出力の対象テーブル (PostgreSQLはスキーマ付き) */
export interface ExportTable {
  schema?: string;
  name: string;
}

/** 外部キーの1件 (ER図用) */
export interface FkInfo {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}
