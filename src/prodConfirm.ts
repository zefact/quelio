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
  return `本番環境の ${table} で、${what}。`;
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
