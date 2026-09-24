/**
 * 実行を1回ぶん進める手順。
 *
 * 実行は「流す文を決める → 危険なSQLか調べる → 確認を出す or 実行を依頼する」
 * と進む。このうち前の2つはバックエンドへの往復で、待っている間は
 * まだ `running` が立っていない。つまり画面の上ではボタンが押せたままで、
 * その間にもう一度押されると、遅れて返ってきたぶんが
 * そのまま2回目の実行になってしまう
 * (文の分割を待つ「カーソルのある文だけ実行」で起きやすい)。
 *
 * そこで2つを組み合わせる。
 *
 *  - 門 … 押した瞬間から実行を依頼するまでを仕切る。同期的に閉まるので、
 *    同じ間に届いた2回目はその場で落ちる (Reactの状態では、
 *    描き直しが済むまで古い値が見えて間に合わない)
 *  - 受付票 … 門を通れた実行に、押した順の番号と宛先
 *    (接続タブ・データベース・シート) を持たせる。
 *    受付票は依頼した先 (パラメータの準備・入力画面) まで持ち回り、
 *    取り消し・確定・タブを閉じた時点で古くなる。
 *    門は依頼した時点で開くので、その先は受付票が受け持つ
 *
 * 門が開いてから受付票が古くなるまでが、1回の実行の寿命になる。
 * 門は接続タブごとに持つ (別の接続の実行を待たせないため)
 */
import { afterDangerCheck } from "./queryGuard";
import type { PendingRun } from "./queryGuard";
import type { DangerousStatement } from "../types/query";
import type { RunTicket } from "../runTicket";

/** 実行を一度に1つだけ通す門 */
export interface RunGate {
  /** 通れたら true。通れた側は必ず leave する */
  enter(): boolean;
  leave(): void;
}

export function createRunGate(): RunGate {
  let busy = false;
  return {
    enter: () => {
      if (busy) return false;
      busy = true;
      return true;
    },
    leave: () => {
      busy = false;
    },
  };
}

/** 1回ぶんの手順に必要なもの (画面から渡す) */
export interface RunSteps {
  /**
   * 受付票を取る (押した瞬間の接続・DB・シートを写し取る)。
   *
   * 門を通れたときだけ呼ぶ (通れなかった押下で番号を進めると、
   * 走っている最中の実行まで古くなってしまう)
   */
  accept: () => RunTicket;
  /**
   * 流す文を決める。
   * 選択・カーソル位置の判断もここで行う (文の分割を待つことがある)。
   * 流すものが無ければ null
   */
  pick: (ticket: RunTicket) => Promise<PendingRun | null>;
  /**
   * 危険なSQLか調べる。調べられなければ投げてよい。
   * 渡さない場合は確認を挟まない (EXPLAINは元々確認を通らない)
   */
  check?: (sql: string) => Promise<DangerousStatement[]>;
  /** そのまま実行を依頼する */
  exec: (run: PendingRun) => void;
  /** 確認を出す */
  confirm: (stmts: DangerousStatement[], run: PendingRun) => void;
  /**
   * 本番の接続か。
   *
   * 危険判定ができなかったときの分かれ道に使う
   * (本番では調べられなかったことを理由に確認する)
   */
  prod?: boolean;
}

/**
 * 実行を1回ぶん進める。
 *
 * 準備 (文の分割) を待っている間も門を閉めたままにするので、
 * 同じ間に押し直されたぶんは実行に進まない。
 * 成功・確認待ち・失敗のどれでも、終わりに必ず門を開ける
 */
export async function startRun(gate: RunGate, steps: RunSteps): Promise<void> {
  if (!gate.enter()) return;
  try {
    const ticket = steps.accept();
    const run = await steps.pick(ticket);
    if (!run) return;
    if (!steps.check) {
      // 確認を挟まない実行 (EXPLAIN)
      steps.exec(run);
      return;
    }
    /** 調べられなかったときは null (扱いは afterDangerCheck が決める) */
    let found: DangerousStatement[] | null = null;
    try {
      found = await steps.check(run.sql);
    } catch {
      /*
       * 判定できなかった。本番では確認を挟み、それ以外は止めない
       * (どちらに倒すかは afterDangerCheck が決める)
       */
    }
    const step = afterDangerCheck(found, steps.prod ?? false, run.sql);
    if (step.kind === "confirm") steps.confirm(step.stmts, run);
    else steps.exec(run);
  } finally {
    gate.leave();
  }
}
