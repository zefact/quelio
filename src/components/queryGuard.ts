/**
 * 実行前の確認をはさむときの、段階の決め方。
 *
 * SQLエディタの実行は「危険なSQLか調べる → 必要なら確認を出す → 実行する」
 * と進む。これまで、確認を待っている間の実行は
 * `setDanger({ stmts, go: () => exec(text) })` のように
 * 「あとで呼ぶ関数」として持たれていた。
 * 何を再開しようとしているのかが関数の中に隠れてしまい、
 * 読んでも追えず、確かめることもできなかった。
 *
 * ここでは、保留している実行を型の付いたデータ (PendingRun) として置き、
 * 「次にどうするか」の判断だけを取り出してある。
 * 判断はどれも画面に触れないので、そのまま試せる
 */
import type { DangerousStatement } from "../types/query";
import type { RunTicket } from "../runTicket";
import type { DbType } from "../types";

/**
 * 確認を待っている実行の中身。
 *
 * 実行設定 (トランザクション・キャプチャ) は「実行を押した時点」の値を持つ。
 * 確認している間に設定を変えても、押したときのつもりで走らせるため
 */
export interface PendingRun {
  /**
   * この実行の受付票。
   *
   * 押した瞬間に取り、実行を依頼するまで持ち回る。
   * 発行元の接続タブ・データベース・シートもここに入っているので、
   * 待っている間に画面を切り替えられても宛先は変わらない。
   * 取り消し・確定・タブを閉じた時点でこの受付票は古くなり、
   * 遅れて届いた要求はそこで落ちる
   */
  ticket: RunTicket;
  /** 実行するSQL (危険判定に掛けたものそのまま) */
  sql: string;
  /** BEGIN〜COMMIT/ROLLBACK に包むか */
  transaction: boolean;
  /** 実行後に結果をキャプチャするか */
  capture: boolean;
  /** 実行計画として流すか (通常の実行では付けない) */
  explain?: "explain" | "analyze";
}

/** 危険判定のあとにやること */
export type GuardStep =
  /** 確認を出す (見つかった文を並べる) */
  | { kind: "confirm"; stmts: DangerousStatement[] }
  /** そのまま実行する */
  | { kind: "run" };

/** 判定できなかったとき、本番で出す説明 */
export const CHECK_FAILED_KIND =
  "判定できませんでした。本番環境のため確認します";

/**
 * 危険判定の結果から、次の段階を決める。
 *
 * `found` が null なのは「判定そのものができなかった」とき。
 * 本番以外では実行を止めない。判定はあくまで気づきを与えるためのもので、
 * バックエンドと話せないだけで手が止まると、かえって使えなくなるため。
 *
 * ただし本番では逆に倒す。調べられなかったことを理由に一度止める方が、
 * 何が流れるか分からないまま本番で走らせるより害が小さい
 */
export function afterDangerCheck(
  found: DangerousStatement[] | null,
  /** 本番の接続か (判定できなかったときの扱いが変わる) */
  prod = false,
  /** 判定できなかったときに確認へ出すSQL (全文) */
  sql = ""
): GuardStep {
  if (found && found.length > 0) return { kind: "confirm", stmts: found };
  if (found === null && prod) {
    return {
      kind: "confirm",
      // 本番の扱い (見出し・バッジ・初期フォーカス) を確認ダイアログに伝える
      stmts: [
        { definitionChange: false, kind: CHECK_FAILED_KIND, sql, prodUpdate: true },
      ],
    };
  }
  return { kind: "run" };
}

/** 確認画面に出す「どこへ何を実行するのか」 */
export interface ConfirmTarget {
  /** 接続名 */
  connection: string;
  /** データベース名 (選んでいなければ出さない) */
  database: string | undefined;
  /** DB種別 (定義変更の注意文がこれで変わる) */
  dbType: DbType;
  /** トランザクションで実行するか */
  transaction: boolean;
}

/**
 * 確認画面に出す対象を、保留している実行そのものから取り出す。
 *
 * 画面の今の値ではなく、実行に使う受付票から作る。
 * 判定を待っている間に別の接続タブへ切り替えられても、
 * 「見せている相手」と「実際に走る相手」がずれない
 */
export function confirmTarget(run: PendingRun): ConfirmTarget {
  return {
    connection: run.ticket.connection,
    database: run.ticket.db ?? undefined,
    dbType: run.ticket.dbType,
    transaction: run.transaction,
  };
}

/**
 * 確認の返事から、実行するものを決める。
 *
 * 実行するなら、保留していた中身をそのまま返す
 * (確認している間にエディタを書き換えられても、確認したSQLが走る)。
 * やめるなら null。保留が無いのに返事が来た場合 (閉じたあとの二重クリックなど) も null
 */
export function afterConfirm(
  pending: PendingRun | null,
  ok: boolean
): PendingRun | null {
  return ok ? pending : null;
}
