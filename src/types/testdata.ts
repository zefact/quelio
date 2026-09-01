/** テストデータ生成でやり取りする型 */

/** 作る値の種類 (Rust側 FieldKind と同じ) */
export type FieldKind =
  | "lastName"
  | "firstName"
  | "fullName"
  | "nameKana"
  | "company"
  | "department"
  | "product"
  | "email"
  | "phone"
  | "mobile"
  | "postalCode"
  | "prefecture"
  | "city"
  | "address"
  | "url"
  | "word"
  | "sentence"
  | "integer"
  | "decimal"
  | "money"
  | "bool"
  | "date"
  | "dateTime"
  | "time"
  | "uuid"
  | "serial"
  | "null";

/**
 * 画面に出す名前 (選ぶ順もこの並び)。
 * 人・会社まわり → 連絡先 → 住所 → 文字 → 数値 → 日時 → その他 の順
 */
export const FIELD_KINDS: [FieldKind, string][] = [
  ["fullName", "氏名"],
  ["lastName", "姓"],
  ["firstName", "名"],
  ["nameKana", "氏名カナ"],
  ["company", "会社名"],
  ["department", "部署名"],
  ["product", "商品名"],
  ["email", "メール"],
  ["phone", "電話番号"],
  ["mobile", "携帯番号"],
  ["url", "URL"],
  ["postalCode", "郵便番号"],
  ["prefecture", "都道府県"],
  ["city", "市区町村"],
  ["address", "住所"],
  ["word", "短い語"],
  ["sentence", "文章"],
  ["integer", "整数"],
  ["decimal", "小数"],
  ["money", "金額"],
  ["bool", "真偽"],
  ["date", "日付"],
  ["dateTime", "日時"],
  ["time", "時刻"],
  ["uuid", "UUID"],
  ["serial", "連番"],
  ["null", "常にNULL"],
];

/** 種類の表示名を引く */
export function fieldKindLabel(kind: FieldKind): string {
  return FIELD_KINDS.find(([k]) => k === kind)?.[1] ?? kind;
}

/** 1列ぶんの「こう作れる」案 */
export interface TestDataColumn {
  name: string;
  /** コメントから取り出した論理名 (無ければ空) */
  logical: string;
  colType: string;
  nullable: boolean;
  /** 自動採番なので値を入れない列 */
  auto: boolean;
  /** 同じ値を作ってはいけない列 (主キー・ユニーク) */
  unique: boolean;
  /** 推測した種類 */
  kind: FieldKind;
  /** 外部キーの参照先 ("テーブル.列"。無ければ空) */
  references: string;
}

/** 生成する列の指定 */
export interface TestDataSpec {
  name: string;
  kind: FieldKind;
}

/** 生成の結果 */
export interface TestDataResult {
  rows: number;
  /** 中止したか (中止した場合は何も入っていない) */
  cancelled: boolean;
}
