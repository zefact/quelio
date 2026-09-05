import { describe, expect, it } from "vitest";
import { handoffRun } from "./paramRequest";
import type { ParamDeps, ParamRequest } from "./paramRequest";
import { createReqSeq } from "./reqSeq";
import { runScope } from "./runTicket";
import type { RunTicket } from "./runTicket";

/** 好きな順番で終わらせられる約束 */
function deferred<T>() {
  let settle!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    settle = r;
  });
  return { promise, settle };
}

const SCOPE = runScope("t1");

const ticketOf = (token: number, key = "t1"): RunTicket => ({
  key,
  token,
  db: "app",
  sheet: "s1",
  connection: "開発",
  dbType: "mysql",
});

const base = (
  sql: string,
  ticket: RunTicket,
  params: string[] = ["id"]
): Omit<ParamRequest, "initial"> => ({
  ticket,
  scope: "profile-1",
  offset: 0,
  sql,
  params,
  transaction: false,
});

/** すぐ揃う準備 */
const quick: ParamDeps = {
  saved: async () => ({ id: { value: "7", kind: "number" } }),
  inferKind: async () => "auto",
};

describe("handoffRun", () => {
  it("パラメータが無ければそのまま実行へ", async () => {
    const seq = createReqSeq();
    const token = seq.start(SCOPE);
    const step = await handoffRun(seq, base("SELECT 1", ticketOf(token), []), quick);
    expect(step).toEqual({ kind: "run" });
  });

  it("保存してある値と型をそのまま初期値にする", async () => {
    const seq = createReqSeq();
    const token = seq.start(SCOPE);
    const step = await handoffRun(seq, base("SELECT :id", ticketOf(token)), quick);
    expect(step.kind).toBe("params");
    if (step.kind !== "params") return;
    expect(step.request.initial).toEqual({ id: { value: "7", kind: "number" } });
  });

  it("保存が無ければ、型はスキーマから推測する", async () => {
    const seq = createReqSeq();
    const token = seq.start(SCOPE);
    const step = await handoffRun(seq, base("SELECT :id", ticketOf(token)), {
      saved: async () => ({}),
      inferKind: async () => "number",
    });
    expect(step.kind === "params" && step.request.initial).toEqual({
      id: { value: "", kind: "number" },
    });
  });

  it("保存値が読めなくても止まらない", async () => {
    const seq = createReqSeq();
    const token = seq.start(SCOPE);
    const step = await handoffRun(seq, base("SELECT :id", ticketOf(token)), {
      saved: () => Promise.reject(new Error("読めない")),
      inferKind: async () => "auto",
    });
    expect(step.kind === "params" && step.request.initial).toEqual({
      id: { value: "", kind: "auto" },
    });
  });

  it("押した後に取り消された要求は、届いた時点で落とす", async () => {
    // 押してから依頼が届くまでの間に取り消された場合
    const seq = createReqSeq();
    const token = seq.start(SCOPE);
    seq.drop(SCOPE);
    expect(await handoffRun(seq, base("SELECT :id", ticketOf(token)), quick)).toEqual({
      kind: "stale",
    });
    // パラメータの無いSQLでも同じ
    expect(
      await handoffRun(seq, base("SELECT 1", ticketOf(token), []), quick)
    ).toEqual({ kind: "stale" });
  });

  it("準備を待っている間に取り消されたら、画面を出さない", async () => {
    const seq = createReqSeq();
    const token = seq.start(SCOPE);
    const slow = deferred<Record<string, { value: string; kind: string }>>();
    const step = handoffRun(seq, base("SELECT :id", ticketOf(token)), {
      saved: () => slow.promise,
      inferKind: async () => "auto",
    });
    seq.drop(SCOPE);
    slow.settle({});
    expect(await step).toEqual({ kind: "stale" });
  });

  it("準備が重なったら、後から押したほうだけが画面になる", async () => {
    const seq = createReqSeq();
    const a = seq.start(SCOPE);
    const slowA = deferred<Record<string, { value: string; kind: string }>>();
    const stepA = handoffRun(seq, base("SELECT :id -- A", ticketOf(a)), {
      saved: () => slowA.promise,
      inferKind: async () => "auto",
    });
    const b = seq.start(SCOPE);
    const stepB = await handoffRun(seq, base("SELECT :id -- B", ticketOf(b)), quick);
    slowA.settle({});

    expect(await stepA).toEqual({ kind: "stale" });
    expect(stepB.kind === "params" && stepB.request.sql).toBe("SELECT :id -- B");
  });

  it("取り消したあとでも、新しく押したぶんは通る", async () => {
    const seq = createReqSeq();
    seq.drop(SCOPE);
    const token = seq.start(SCOPE);
    const step = await handoffRun(seq, base("SELECT :id", ticketOf(token)), quick);
    expect(step.kind).toBe("params");
  });

  it("別のタブの取り消しに巻き込まれない", async () => {
    const seq = createReqSeq();
    const token = seq.start(SCOPE);
    const slow = deferred<Record<string, { value: string; kind: string }>>();
    const step = handoffRun(seq, base("SELECT :id", ticketOf(token)), {
      saved: () => slow.promise,
      inferKind: async () => "auto",
    });
    seq.drop(runScope("t2"));
    slow.settle({});
    expect((await step).kind).toBe("params");
  });
});
