/**
 * 本番環境での更新を、実行の直前に一度止めるときの文言。
 *
 * 「止めるかどうか」の判定はRust側 (`needs_update_confirm` /
 * `confirm_env`) が持つ。ここにあるのは画面に出す文だけで、
 * どれも画面に触れないのでそのまま試せる。
 *
 * 文は短くする。環境・接続名・テーブル名が1行で分かれば足りる。
 * 長い注意書きは読まれないまま「はい」を押されてしまう
 */
import type { DangerousStatement } from "./types/query";
import type {
  ColumnChange,
  ForeignKeyChange,
  IndexChange,
} from "./types/schema";
import type { KvChange } from "./types/kv";

/** 確認ダイアログの見出し */
export interface ConfirmHeading {
  /** 見出しの文 */
  title: string;
  /** 本番の更新が混ざっているか (バッジを出すかの判断に使う) */
  prod: boolean;
}

/**
 * 危険SQLの確認ダイアログの見出しを決める。
 *
 * 本番の更新として拾われた文が1つでもあれば、そちらを前に出す。
 * 「DROPが含まれています」より「本番環境で更新を実行します」の方が、
 * 手を止める理由として強いため
 */
export function confirmHeading(statements: DangerousStatement[]): ConfirmHeading {
  const prod = statements.some((s) => s.prodUpdate === true);
  return {
    title: prod ? "本番環境で更新を実行します" : "このSQLを実行しますか",
    prod,
  };
}

/** データタブでの1回の確定が何をするか */
export type RowChangeKind = "insert" | "update" | "delete";

/**
 * データタブの確定・行追加・行削除を本番で確認するときの1行。
 *
 * セルごとではなく「確定1回につき1行」にする
 * (1回の確定で何が起きるかだけを伝えたい)
 */
export function rowChangeText(kind: RowChangeKind, table: string): string {
  const what =
    kind === "insert"
      ? "1行を追加します"
      : kind === "delete"
        ? "1行を削除します"
        : "1行の内容を書き換えます";
  return prodActionText(table, what);
}

/**
 * 本番の1行の決まった形。「本番環境の {どこ} で、{何をする}。」
 *
 * どの確認でも同じ形にして、読み飛ばされにくくする
 * (形がそろっていれば、違うのは「どこ」と「何」だけになる)
 */
export function prodActionText(where: string, what: string): string {
  return `本番環境の ${where} で、${what}。`;
}

/**
 * 構造タブ (カラム・インデックス・外部キー・日本語名) の変更を、
 * 実行の前に確認するか。
 *
 * 本番は必ず確認する。それ以外は設定「定義の変更も確認する」(confirmAlter) に従う
 * (SQLエディタで ALTER を流すときと同じ決まりにする)
 */
export function needsStructureConfirm(
  prod: boolean,
  confirmAlter: boolean
): boolean {
  return prod || confirmAlter;
}

/** カラムの変更が何をするか (確認の1行・見出しに使う) */
export function columnChangeWhat(change: ColumnChange): string {
  switch (change.kind) {
    case "add":
      return `カラム ${change.column.name} を追加します`;
    case "drop":
      return `カラム ${change.name} を削除します`;
    case "modify":
      if (change.before.name !== change.column.name) {
        return `カラム ${change.before.name} を ${change.column.name} に変更します`;
      }
      // 並べ替え (位置だけを指定した変更)
      return change.column.after
        ? `カラム ${change.column.name} の位置を変えます`
        : `カラム ${change.column.name} の定義を変更します`;
  }
}

/** インデックスの変更が何をするか */
export function indexChangeWhat(change: IndexChange): string {
  switch (change.kind) {
    case "add":
      return `インデックス ${change.index.name} を作成します`;
    case "drop":
      return `インデックス ${change.name} を削除します`;
    case "modify":
      return `インデックス ${change.before} を作り直します`;
  }
}

/** 外部キーの変更が何をするか */
export function foreignKeyChangeWhat(change: ForeignKeyChange): string {
  return change.kind === "add"
    ? `外部キー${change.fk.name ? ` ${change.fk.name} ` : ""}を追加します`
    : `外部キー ${change.name} を削除します`;
}

/** テーブルの日本語名 (コメント) の変更が何をするか */
export function tableNameWhat(next: string): string {
  return next === ""
    ? "日本語名を消します"
    : `日本語名を「${next}」にします`;
}

/** Valkey の画面操作が何をするか */
export function kvChangeWhat(change: KvChange): string {
  switch (change.kind) {
    case "rename":
      return `キー ${change.key} の名前を ${change.newKey} に変えます`;
    case "expire":
      return change.ttl <= 0
        ? `キー ${change.key} を無期限にします`
        : `キー ${change.key} の TTL を ${change.ttl} 秒にします`;
    case "createKey":
      return `キー ${change.key} を作成します`;
    case "deleteKey":
      return `キー ${change.key} を削除します`;
    case "insert":
      return `キー ${change.key} に要素を追加します`;
    case "update":
      return `キー ${change.key} の要素を書き換えます`;
    case "remove":
      return `キー ${change.key} の要素を1件削除します`;
  }
}

/**
 * CSV取り込みを本番で確認するときの1行。
 *
 * `truncated` は下見が上限で打ち切られたとき。
 * 数えた行数より多く入るので、「以上」と書いて実際より少なく見せない
 */
export function csvImportText(
  table: string,
  rows: number,
  truncated = false
): string {
  const count = `${rows.toLocaleString()} 行${truncated ? "以上" : ""}`;
  return `本番環境の ${table} へ ${count}取り込みます。`;
}

/** SQLファイル実行を本番で確認するときの1行 */
export function sqlFileText(database: string, fileName: string): string {
  return `本番環境の ${database} で、SQLファイル ${fileName} を実行します。`;
}

/** テストデータの作成を本番で確認するときの1行 */
export function testDataText(table: string, rows: number): string {
  return `本番環境の ${table} へ、テストデータを ${rows.toLocaleString()} 行入れます。`;
}

/**
 * ユーザー・権限の変更を本番で確認するときの1行。
 *
 * `action` は確認ダイアログの見出し (「権限を付けます」など)。
 * 文の終わりの「。」はここで足す
 */
export function dbUserChangeText(target: string, action: string): string {
  return `本番環境の ${target} について、${action.replace(/。$/, "")}。`;
}

/** データベース管理の操作 */
export type DbAdminAction =
  | { kind: "create"; what: string; name: string }
  | { kind: "drop"; what: string; name: string }
  | { kind: "owner"; name: string; owner: string };

/** データベース・スキーマの作成・削除・所有者の変更を本番で確認するときの1行 */
export function dbAdminText(a: DbAdminAction): string {
  switch (a.kind) {
    case "create":
      return `本番環境に${a.what} ${a.name} を作成します。`;
    case "drop":
      return `本番環境の${a.what} ${a.name} を削除します。`;
    case "owner":
      return `本番環境のデータベース ${a.name} の所有者を ${a.owner} に変更します。`;
  }
}

/** サイドバーでのテーブル名の変更が何をするか (確認の1行・本文に使う) */
export function tableRenameWhat(from: string, to: string): string {
  return `テーブル名を ${from} から ${to} に変更します`;
}
