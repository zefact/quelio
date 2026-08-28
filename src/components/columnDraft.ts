/** カラムのインライン編集で使う下書きデータと、その変換ヘルパー */

import { CLOSING, parseComment } from "../comment";
import type { ColumnInfo, ColumnSpec } from "../types";

/** 編集できるセル (この列をダブルクリックすると行が編集状態になる) */
export type EditField =
  | "name"
  | "type"
  /** 型のサイズ部分 (型文字列の括弧内を書き換える) */
  | "size"
  | "null"
  | "default"
  | "logical"
  | "note"
  | "comment"
  /** 照合順序 (MySQL / PostgreSQL) */
  | "collation"
  /** MySQLの属性 (AUTO_INCREMENT など) */
  | "extra";

/** 編集中の行の入力値 */
export interface ColumnDraft {
  name: string;
  /** 型 (サイズ込みの文字列。例: varchar(255)) */
  colType: string;
  nullable: boolean;
  /** デフォルト値の式 (空なら指定なし) */
  default: string;
  /** コメント分割表示のときの論理名 */
  logical: string;
  /** コメント分割表示のときの補足 */
  note: string;
  /** コメントをそのまま扱うときの本文 */
  comment: string;
  /** MySQLの属性 (AUTO_INCREMENT / ON UPDATE CURRENT_TIMESTAMP / なし) */
  extra: ExtraKind;
  /** 照合順序 (空ならDBの既定) */
  collation: string;
}

/** 画面で選べるMySQLの属性 */
export type ExtraKind = "" | "AUTO_INCREMENT" | "ON UPDATE CURRENT_TIMESTAMP";

/** 属性の選択肢 (表示名つき) */
export const EXTRA_OPTIONS: [ExtraKind, string][] = [
  ["", "なし"],
  ["AUTO_INCREMENT", "AUTO_INCREMENT"],
  ["ON UPDATE CURRENT_TIMESTAMP", "ON UPDATE CURRENT_TIMESTAMP"],
];

/**
 * information_schemaのEXTRAを、画面で扱う3種類に丸める。
 * MySQL 8は "DEFAULT_GENERATED on update CURRENT_TIMESTAMP" のように
 * 複数の情報が混ざるため、含まれるキーワードで判定する
 */
export function normalizeExtra(raw: string | undefined | null): ExtraKind {
  const u = (raw ?? "").toUpperCase();
  if (u.includes("AUTO_INCREMENT")) return "AUTO_INCREMENT";
  if (u.includes("ON UPDATE CURRENT_TIMESTAMP")) {
    return "ON UPDATE CURRENT_TIMESTAMP";
  }
  return "";
}

/** "varchar(100)" → 型: varchar / サイズ: 100 に分離する */
export function splitType(colType: string): { base: string; size: string } {
  const m = colType.match(/^([^(]+)\(([^)]*)\)(.*)$/);
  if (!m) return { base: colType, size: "" };
  return { base: `${m[1]}${m[3] ?? ""}`.trim(), size: m[2] };
}

/** 論理名と補足を1つのコメント文字列に戻す */
export function joinComment(
  logical: string,
  note: string,
  delim: string
): string {
  const l = logical.trim();
  const n = note.trim();
  if (!n) return l;
  if (!delim) return l ? `${l} ${n}` : n;
  return `${l}${delim}${n}${CLOSING[delim] ?? ""}`;
}

/**
 * デフォルト値の表示・入力用の文字列。
 * 空文字のデフォルトは指定なしと区別できるよう '' と表す
 */
function defaultText(c: ColumnInfo): string {
  if (c.default === undefined || c.default === null) return "";
  return c.default === "" ? "''" : c.default;
}

/** 既存カラムを下書きに変換する */
export function toDraft(c: ColumnInfo, delim: string): ColumnDraft {
  const [logical, note] = parseComment(c.comment ?? "", delim);
  return {
    name: c.name,
    colType: c.colType,
    nullable: c.nullable,
    default: defaultText(c),
    logical,
    note,
    comment: c.comment ?? "",
    extra: normalizeExtra(c.extra),
    collation: c.collation ?? "",
  };
}

/** 追加用の空の下書き */
export function emptyDraft(): ColumnDraft {
  return {
    name: "",
    colType: "",
    nullable: true,
    default: "",
    logical: "",
    note: "",
    comment: "",
    extra: "",
    collation: "",
  };
}

/** 既存カラムを、変更前の内容 (差分比較用) として ColumnSpec に変換する */
export function specOfColumn(c: ColumnInfo): ColumnSpec {
  return {
    name: c.name,
    colType: c.colType,
    nullable: c.nullable,
    default: defaultText(c),
    comment: c.comment ?? "",
    extra: normalizeExtra(c.extra),
    collation: c.collation ?? "",
  };
}

/** 下書きを ColumnSpec に変換する */
export function specOfDraft(
  d: ColumnDraft,
  split: boolean,
  delim: string
): ColumnSpec {
  return {
    name: d.name.trim(),
    colType: d.colType.trim(),
    nullable: d.nullable,
    default: d.default,
    comment: split ? joinComment(d.logical, d.note, delim) : d.comment,
    extra: d.extra,
    collation: d.collation,
  };
}

/**
 * 型名の後ろに付く修飾語。
 * サイズの括弧はこれらの手前に入れる
 * (例: decimal(10,2) unsigned / timestamp(3) without time zone)
 */
const TYPE_MODIFIERS = ["unsigned", "zerofill", "with", "without", "varying"];

/**
 * 型名 (サイズなし) とサイズから、DBに渡す型文字列を組み立てる。
 *
 * "varchar" + "255"                    → varchar(255)
 * "decimal unsigned" + "10,2"          → decimal(10,2) unsigned
 * "timestamp without time zone" + "3"  → timestamp(3) without time zone
 * "character varying" + "255"          → character varying(255)
 */
export function joinType(base: string, size: string): string {
  const b = base.trim().replace(/\s+/g, " ");
  const s = size.trim();
  if (!s) return b;
  if (!b) return "";
  const words = b.split(" ");
  // "varying" だけは型名の一部なので、その次から修飾語として扱う
  let at = words.findIndex(
    (w, i) => i > 0 && TYPE_MODIFIERS.includes(w.toLowerCase()) && w.toLowerCase() !== "varying"
  );
  if (at < 0) at = words.length;
  const head = words.slice(0, at).join(" ");
  const tail = words.slice(at).join(" ");
  return tail ? `${head}(${s}) ${tail}` : `${head}(${s})`;
}

/** 型文字列のサイズ部分だけを差し替える (サイズ欄の編集用) */
export function withSize(colType: string, size: string): string {
  return joinType(splitType(colType).base, size);
}

/** 型文字列の型名部分だけを差し替える (型欄の編集用) */
export function withBase(colType: string, base: string): string {
  return joinType(base, splitType(colType).size);
}

/** 型のサイズ指定 (例: "10,2") を数値の並びにする。数値以外が混ざればnull */
function sizeNumbers(size: string): number[] | null {
  if (!size.trim()) return null;
  const nums = size.split(",").map((p) => Number(p.trim()));
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

/**
 * データが失われうる変更を挙げる (空なら確認は不要)。
 * 実行してしまうと戻せないので、実行前の確認に使う
 */
export function riskyChanges(before: ColumnSpec, after: ColumnSpec): string[] {
  const reasons: string[] = [];
  const a = splitType(before.colType.trim().toLowerCase());
  const b = splitType(after.colType.trim().toLowerCase());
  if (a.base !== b.base) {
    reasons.push(
      `型を ${before.colType} から ${after.colType} へ変更します (値が変換できないと失敗し、変換できても丸められることがあります)`
    );
  } else {
    // 桁数・小数部のどれか1つでも小さくなれば「縮小」とみなす
    const na = sizeNumbers(a.size);
    const nb = sizeNumbers(b.size);
    const shrink =
      na !== null &&
      nb !== null &&
      na.length === nb.length &&
      nb.some((n, i) => n < na[i]);
    if (shrink) {
      reasons.push(
        `型のサイズを ${before.colType} から ${after.colType} へ縮めます (収まらない値は切り詰め・エラーになります)`
      );
    }
  }
  if (before.nullable && !after.nullable) {
    reasons.push(
      "NULL可 から NOT NULL へ変更します (NULLの行が残っていると失敗します)"
    );
  }
  // 文字セット・照合順序が変わると、変換できない文字が失われることがある
  const collA = (before.collation ?? "").trim().toLowerCase();
  const collB = (after.collation ?? "").trim().toLowerCase();
  if (collA && collB && collA !== collB) {
    reasons.push(
      `照合順序を ${before.collation} から ${after.collation} へ変更します (文字セットが変わると変換できない文字が失われます)`
    );
  }
  return reasons;
}
