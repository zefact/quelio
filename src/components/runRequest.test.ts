import { describe, expect, it } from "vitest";
import { createRunGate, startRun } from "./runRequest";
import type { RunSteps } from "./runRequest";
import type { PendingRun } from "./queryGuard";
import type { RunTicket } from "../runTicket";
import type { DangerousStatement } from "../types/query";

/** 好きな順番で終わらせられる約束 */
function deferred<T>() {
  let settle!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    settle = r;
  });
  return { promise, settle };
}

const ticketOf = (token: number): RunTicket => ({
  key: "t1",
  token,
  db: "app",
  sheet: "s1",
  connection: "開発",
  dbType: "mysql",
});

const runOf = (sql: string, token = 1): PendingRun => ({
  ticket: ticketOf(token),
  sql,
  transaction: false,
  capture: false,
});

const danger: DangerousStatement = {
  definitionChange: false,
  kind: "WHERE の無い UPDATE",
  sql: "UPDATE t SET a = 1",
};

/** 記録つきの手順一式 */
function steps(over: Partial<RunSteps> = {}) {
  const execed: PendingRun[] = [];
  const confirmed: PendingRun[] = [];
  /** 発行した受付番号 (押した順) */
  const tokens: number[] = [];
  let next = 0;
  const s: RunSteps = {
    accept: () => {
      next += 1;
      tokens.push(next);
      return ticketOf(next);
    },
    pick: async (ticket) => runOf("SELECT 1", ticket.token),
    check: async () => [],
    exec: (r) => execed.push(r),
    confirm: (_stmts, r) => confirmed.push(r),
    ...over,
  };
  return { s, execed, confirmed, tokens };
}

/** 危険判定を通さない手順 (EXPLAINと同じ形) */
function noCheck(s: RunSteps): RunSteps {
  const { check: _check, ...rest } = s;
  return rest;
}

describe("startRun — 準備中の二重受付", () => {
  it("文の分割を待っている間に押し直しても、実行依頼は1回だけ", () => {
    /*
     * 報告された順序をそのまま再現する。
     * 1. Aが文の分割を始める (まだ終わらない)
     * 2. Bも押される
     * 3. Aの分割が終わり、Aだけが実行へ進む
     */
    const gate = createRunGate();
    const split = deferred<PendingRun | null>();
    let picks = 0;
    const { s, execed, tokens } = steps({
      pick: () => {
        picks++;
        return split.promise;
      },
    });

    const a = startRun(gate, s);
    const b = startRun(gate, s);
    // Bは門で止まるので、分割の依頼すら出ない
    expect(picks).toBe(1);

    // 門で止まった側は受付番号も取らない
    // (取ってしまうと、走っている最中の実行まで古くなる)
    expect(tokens).toEqual([1]);

    split.settle(runOf("SELECT 1"));
    return Promise.all([a, b]).then(() => {
      expect(execed).toHaveLength(1);
    });
  });

  it("遅れて返ってきた分割で、2回目の実行にならない", async () => {
    // 分割が返る順が入れ替わっても、通ったのは1回だけ
    const gate = createRunGate();
    const first = deferred<PendingRun | null>();
    const picked: PendingRun[] = [];
    const { s, execed } = steps({
      pick: (ticket) => {
        const run = runOf(`SELECT ${picked.length + 1}`, ticket.token);
        picked.push(run);
        return first.promise;
      },
    });

    const a = startRun(gate, s);
    const b = startRun(gate, s);
    const c = startRun(gate, s);
    first.settle(picked[0]);
    await Promise.all([a, b, c]);

    expect(execed.map((r) => r.sql)).toEqual(["SELECT 1"]);
  });

  it("前の実行が終われば、次はふつうに通る", async () => {
    const gate = createRunGate();
    const { s, execed } = steps();
    await startRun(gate, s);
    await startRun(gate, s);
    expect(execed).toHaveLength(2);
  });

  it("流す文が無ければ何もせず、門も開く", async () => {
    const gate = createRunGate();
    const { s, execed } = steps({ pick: async () => null });
    await startRun(gate, s);
    expect(execed).toHaveLength(0);

    const next = steps();
    await startRun(gate, next.s);
    expect(next.execed).toHaveLength(1);
  });

  it("危険なSQLなら確認を出し、実行はしない", async () => {
    const gate = createRunGate();
    const { s, execed, confirmed } = steps({ check: async () => [danger] });
    await startRun(gate, s);
    expect(execed).toHaveLength(0);
    expect(confirmed).toHaveLength(1);
    // 確認した文がそのまま渡る
    expect(confirmed[0].sql).toBe("SELECT 1");
  });

  it("判定できなくても実行は止めない (現行の方針)", async () => {
    const gate = createRunGate();
    const { s, execed } = steps({
      check: () => Promise.reject(new Error("つながらない")),
    });
    await startRun(gate, s);
    expect(execed).toHaveLength(1);
  });

  it("途中で投げても門が閉じたままにならない", async () => {
    const gate = createRunGate();
    const bad = steps({ pick: () => Promise.reject(new Error("失敗")) });
    await expect(startRun(gate, bad.s)).rejects.toThrow("失敗");

    const next = steps();
    await startRun(gate, next.s);
    expect(next.execed).toHaveLength(1);
  });

  it("危険判定を渡さなければ、確認を挟まず実行する (EXPLAINの経路)", async () => {
    const gate = createRunGate();
    let checked = 0;
    const { s, execed, confirmed } = steps({
      check: async () => {
        checked++;
        return [danger];
      },
    });
    await startRun(gate, noCheck(s));
    // 危険判定そのものが呼ばれない = 確認も出ない
    expect(checked).toBe(0);
    expect(confirmed).toHaveLength(0);
    expect(execed).toHaveLength(1);
  });

  it("EXPLAINと通常実行は、同じ門で1つに絞られる", async () => {
    // 通常実行が分割を待っている間にEXPLAINを押しても、進むのは片方だけ
    const gate = createRunGate();
    const split = deferred<PendingRun | null>();
    const normal = steps({ pick: () => split.promise });
    const a = startRun(gate, normal.s);

    const explain = steps();
    await startRun(gate, noCheck(explain.s));
    expect(explain.execed).toHaveLength(0);
    // 門で止まったので、受付番号も進めていない
    expect(explain.tokens).toEqual([]);

    split.settle(runOf("SELECT 1"));
    await a;
    expect(normal.execed).toHaveLength(1);
  });

  it("逆順 (EXPLAINが先) でも同じ", async () => {
    const gate = createRunGate();
    const slow = deferred<PendingRun | null>();
    const explain = steps({ pick: () => slow.promise });
    const a = startRun(gate, noCheck(explain.s));

    const normal = steps();
    await startRun(gate, normal.s);
    expect(normal.execed).toHaveLength(0);

    slow.settle(runOf("EXPLAIN SELECT 1"));
    await a;
    expect(explain.execed.map((r) => r.sql)).toEqual(["EXPLAIN SELECT 1"]);
  });
});
