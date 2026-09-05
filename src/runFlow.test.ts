/**
 * 受け渡しをまたぐ確認。
 *
 * 画面側 (startRun) と App 側 (handoffRun) を、App.tsx と同じ順につないで
 * 「押した後に取り消した実行が復活しないこと」と
 * 「押した接続と違う接続へSQLが渡らないこと」を見る。
 *
 * つなぎ目そのもの (setParamReq / execRunQuery の呼び分け) は
 * React と IPC を伴うのでここでは通していない
 */
import { describe, expect, it } from "vitest";
import { createRunGate, startRun } from "./components/runRequest";
import type { RunSteps } from "./components/runRequest";
import type { PendingRun } from "./components/queryGuard";
import { handoffRun } from "./paramRequest";
import type { ParamDeps, ParamRequest } from "./paramRequest";
import { createReqSeq } from "./reqSeq";
import { runScope } from "./runTicket";
import { confirmTarget } from "./components/queryGuard";
import type { RunTicket } from "./runTicket";
import { extractParams } from "./sqlParams";

/** 好きな順番で終わらせられる約束 */
function deferred<T>() {
  let settle!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    settle = r;
  });
  return { promise, settle };
}

/**
 * App 側。
 *
 * handleRunQuery が handoffRun の結果で行う分岐と同じ形にしてある。
 * 宛先は必ず受付票から取る (App.tsx と同じ)
 */
function makeApp(deps: ParamDeps) {
  const seq = createReqSeq();
  /** 今表示しているタブ (useStableActions が最新を見てしまう部分) */
  let showing = "A";
  /** 出した入力画面 */
  const dialogs: ParamRequest[] = [];
  /** バックエンドへ出した実行依頼 (宛先つき) */
  const ran: { key: string; db: string | null; sheet: string; sql: string }[] =
    [];
  /** 閉じたタブ */
  const closed = new Set<string>();
  const inflight: Promise<unknown>[] = [];

  const onRun = (run: PendingRun) => {
    const p = handoffRun(
      seq,
      {
        ticket: run.ticket,
        scope: `profile-${run.ticket.key}`,
        offset: 0,
        sql: run.sql,
        params: extractParams(run.sql),
        transaction: run.transaction,
        explain: run.explain,
      },
      deps
    ).then((step) => {
      if (step.kind === "stale") return;
      if (step.kind === "params") {
        // 待っている間にタブが閉じていたら画面は出さない
        if (!closed.has(step.request.ticket.key)) dialogs.push(step.request);
        return;
      }
      ran.push({
        key: run.ticket.key,
        db: run.ticket.db,
        sheet: run.ticket.sheet,
        sql: run.sql,
      });
    });
    inflight.push(p);
  };

  return {
    seq,
    dialogs,
    ran,
    onRun,
    /** 受付票を作る (App の onAcceptRun と同じ。押した瞬間の宛先を写す) */
    accept: (db: string | null = "app", sheet = "s1"): RunTicket => ({
      key: showing,
      token: seq.start(runScope(showing)),
      db,
      sheet,
      connection: `接続${showing}`,
      dbType: showing === "A" ? "mysql" : "postgresql",
    }),
    /** 接続タブを切り替える */
    show: (key: string) => {
      showing = key;
    },
    /** 入力画面の取り消し・確定 */
    dropRuns: (key: string) => seq.drop(runScope(key)),
    closeTab: (key: string) => {
      closed.add(key);
      seq.drop(runScope(key));
    },
    settled: () => Promise.all(inflight),
  };
}

/** 画面側の手順一式 */
function makeSteps(
  app: ReturnType<typeof makeApp>,
  over: Partial<RunSteps> = {}
): RunSteps {
  return {
    accept: () => app.accept(),
    pick: async (ticket) => ({
      ticket,
      sql: "SELECT 1",
      transaction: false,
      capture: false,
    }),
    check: async () => [],
    exec: app.onRun,
    confirm: () => {},
    ...over,
  };
}

const quick: ParamDeps = {
  saved: async () => ({}),
  inferKind: async () => "auto",
};

const pick = (sql: string) => async (ticket: RunTicket) => ({
  ticket,
  sql,
  transaction: false,
  capture: false,
});

describe("宛先の取り違え", () => {
  it("準備中に別の接続へ切り替えても、押した接続で実行する", async () => {
    /*
     * 1. 接続Bで一度実行し、Bの受付番号を1にする
     * 2. 接続Aで実行を押す。Aの受付番号も1になる (番号だけでは区別できない)
     * 3. Aが文の分割を待っている間に、接続Bへ切り替える
     * 4. Aの分割が終わって依頼が届く
     *
     * 宛先を「今表示しているタブ」から決めると、AのSQLがBへ渡る
     */
    const app = makeApp(quick);

    // 1. B で1回実行 (Bの番号が1になる)
    app.show("B");
    await startRun(createRunGate(), makeSteps(app, { pick: pick("SELECT b") }));
    await app.settled();
    expect(app.ran.map((r) => r.key)).toEqual(["B"]);

    // 2. A で実行を押す (Aの番号も1)
    app.show("A");
    const splitA = deferred<PendingRun | null>();
    let ticketA: RunTicket | null = null;
    const a = startRun(
      createRunGate(),
      makeSteps(app, {
        pick: (ticket) => {
          ticketA = ticket;
          return splitA.promise;
        },
      })
    );
    expect(ticketA).not.toBeNull();
    const issued = ticketA as unknown as RunTicket;
    expect(issued.key).toBe("A");
    // AとBの番号は同じ (番号だけを頼りにすると取り違える)
    expect(issued.token).toBe(1);

    // 3. Bへ切り替える
    app.show("B");

    // 4. Aの分割が終わる
    splitA.settle({
      ticket: issued,
      sql: "SELECT a",
      transaction: false,
      capture: false,
    });
    await a;
    await app.settled();

    // AのSQLはAへ。Bへは渡らない
    expect(app.ran).toEqual([
      { key: "B", db: "app", sheet: "s1", sql: "SELECT b" },
      { key: "A", db: "app", sheet: "s1", sql: "SELECT a" },
    ]);
  });

  it("準備中に切り替えて、発行元を閉じたら実行しない", async () => {
    const app = makeApp(quick);
    // 先にBで1回実行し、AとBの受付番号をわざと同じにする
    app.show("B");
    await startRun(createRunGate(), makeSteps(app, { pick: pick("SELECT b") }));
    await app.settled();
    app.ran.length = 0;

    app.show("A");
    const splitA = deferred<PendingRun | null>();
    let ticketA: RunTicket | null = null;
    const a = startRun(
      createRunGate(),
      makeSteps(app, {
        pick: (ticket) => {
          ticketA = ticket;
          return splitA.promise;
        },
      })
    );
    app.show("B");
    app.closeTab("A");

    splitA.settle({
      ticket: ticketA as unknown as RunTicket,
      sql: "SELECT a",
      transaction: false,
      capture: false,
    });
    await a;
    await app.settled();

    expect(app.ran).toHaveLength(0);
    expect(app.dialogs).toHaveLength(0);
  });

  it("入力の準備中に発行元を閉じたら、入力画面も出ない", async () => {
    const saved = deferred<Record<string, { value: string; kind: string }>>();
    const app = makeApp({
      saved: () => saved.promise,
      inferKind: async () => "auto",
    });
    app.show("A");
    await startRun(createRunGate(), makeSteps(app, { pick: pick("SELECT :id") }));
    app.show("B");
    app.closeTab("A");
    saved.settle({});
    await app.settled();

    expect(app.dialogs).toHaveLength(0);
    expect(app.ran).toHaveLength(0);
  });

  it("別の接続の実行は、互いを止めない", async () => {
    // Aの準備が終わらなくても、Bの実行は通る
    const app = makeApp(quick);
    app.show("A");
    const splitA = deferred<PendingRun | null>();
    const a = startRun(
      createRunGate(),
      makeSteps(app, { pick: () => splitA.promise })
    );

    app.show("B");
    await startRun(createRunGate(), makeSteps(app, { pick: pick("SELECT b") }));
    await app.settled();
    expect(app.ran.map((r) => r.key)).toEqual(["B"]);

    // Aも後から通る (Bの実行で古くなっていない)
    app.show("A");
    splitA.settle({
      ticket: {
        key: "A",
        token: 1,
        db: "app",
        sheet: "s1",
        connection: "接続A",
        dbType: "mysql",
      },
      sql: "SELECT a",
      transaction: false,
      capture: false,
    });
    await a;
    await app.settled();
    expect(app.ran.map((r) => r.key)).toEqual(["B", "A"]);
  });

  it("押した時点のデータベースとシートへ返す", async () => {
    // 準備中にDBやシートを切り替えても、押したときの宛先のまま
    const saved = deferred<Record<string, { value: string; kind: string }>>();
    const app = makeApp({
      saved: () => saved.promise,
      inferKind: async () => "auto",
    });
    app.show("A");
    await startRun(
      createRunGate(),
      makeSteps(app, {
        accept: () => app.accept("shop", "sheet-1"),
        pick: pick("SELECT :id"),
      })
    );
    saved.settle({});
    await app.settled();

    const req = app.dialogs[0];
    expect(req.ticket.db).toBe("shop");
    expect(req.ticket.sheet).toBe("sheet-1");
  });
});

describe("確認画面に出す対象", () => {
  it("判定を待つ間に別の接続へ切り替えても、押した接続を出す", async () => {
    /*
     * 1. 接続A (MySQL) で危険なSQLを実行する
     * 2. 危険判定を待っている間に、接続B (PostgreSQL) へ切り替える
     * 3. Aの判定が終わり、確認画面が出る
     *
     * 表示を画面の今の値から取ると、Bの名前とDB種別が出てしまう。
     * 続行するとAで実行されるので、見せた相手と走る相手が食い違う
     */
    const app = makeApp(quick);
    app.show("A");
    const judging = deferred<
      { definitionChange: boolean; kind: string; sql: string }[]
    >();
    let shown: PendingRun | null = null;
    const run = startRun(
      createRunGate(),
      makeSteps(app, {
        accept: () => app.accept("shop", "s1"),
        pick: pick("UPDATE t SET a = 1"),
        check: () => judging.promise,
        confirm: (_stmts, r) => {
          shown = r;
        },
      })
    );

    // 2. 切り替え
    app.show("B");
    // 3. 判定が戻る (危険なSQLが見つかった)
    judging.settle([
      { definitionChange: false, kind: "危険", sql: "UPDATE t SET a = 1" },
    ]);
    await run;

    const target = confirmTarget(shown as unknown as PendingRun);
    expect(target).toEqual({
      connection: "接続A",
      database: "shop",
      dbType: "mysql",
      transaction: false,
    });
  });

  it("続行すると、確認に出した対象で実行される", async () => {
    const app = makeApp(quick);
    app.show("A");
    let shown: PendingRun | null = null;
    await startRun(
      createRunGate(),
      makeSteps(app, {
        accept: () => app.accept("shop", "s1"),
        pick: pick("UPDATE t SET a = 1"),
        check: async () => [
          { definitionChange: false, kind: "危険", sql: "UPDATE t SET a = 1" },
        ],
        confirm: (_stmts, r) => {
          shown = r;
        },
      })
    );
    app.show("B");

    const go = shown as unknown as PendingRun;
    const target = confirmTarget(go);
    app.onRun(go);
    await app.settled();

    // 確認に出した接続・DBと、実際に流した宛先が一致する
    expect(app.ran).toEqual([
      { key: "A", db: "shop", sheet: "s1", sql: "UPDATE t SET a = 1" },
    ]);
    expect(target.connection).toBe("接続A");
    expect(target.database).toBe("shop");
  });

  it("やめれば実行されない", async () => {
    const app = makeApp(quick);
    app.show("A");
    await startRun(
      createRunGate(),
      makeSteps(app, {
        pick: pick("UPDATE t SET a = 1"),
        check: async () => [
          { definitionChange: false, kind: "危険", sql: "UPDATE t SET a = 1" },
        ],
      })
    );
    await app.settled();
    expect(app.ran).toHaveLength(0);
  });

  it("発行元を閉じたあとは、別の接続へ振り替えず実行もしない", async () => {
    const app = makeApp(quick);
    app.show("A");
    let shown: PendingRun | null = null;
    await startRun(
      createRunGate(),
      makeSteps(app, {
        pick: pick("UPDATE t SET a = 1"),
        check: async () => [
          { definitionChange: false, kind: "危険", sql: "UPDATE t SET a = 1" },
        ],
        confirm: (_stmts, r) => {
          shown = r;
        },
      })
    );
    app.show("B");
    app.closeTab("A");

    const go = shown as unknown as PendingRun;
    // 表示は最後までAのまま (Bへ読み替えない)
    expect(confirmTarget(go).connection).toBe("接続A");
    // 続行しても、失効しているので実行されない
    app.onRun(go);
    await app.settled();
    expect(app.ran).toHaveLength(0);
  });
});

describe("受け渡しをまたぐ受付 (同じ接続の中)", () => {
  const app1 = () => {
    const app = makeApp(quick);
    app.show("A");
    return app;
  };

  it("後から押したぶんが、待っている実行を古くする", async () => {
    const savedA = deferred<Record<string, { value: string; kind: string }>>();
    let first = true;
    const app = makeApp({
      saved: () => {
        if (!first) return Promise.resolve({});
        first = false;
        return savedA.promise;
      },
      inferKind: async () => "auto",
    });
    app.show("A");
    const gate = createRunGate();

    await startRun(gate, makeSteps(app, { pick: pick("SELECT :id -- A") }));
    await startRun(gate, makeSteps(app, { pick: pick("SELECT :id -- B") }));
    savedA.settle({});
    await app.settled();

    expect(app.dialogs.map((d) => d.sql)).toEqual(["SELECT :id -- B"]);
    expect(app.ran).toHaveLength(0);
  });

  it("取り消しの前に押した実行は、あとから入力画面を出さない", async () => {
    const savedA = deferred<Record<string, { value: string; kind: string }>>();
    const app = makeApp({
      saved: () => savedA.promise,
      inferKind: async () => "auto",
    });
    app.show("A");
    const gate = createRunGate();

    // A (準備待ち)
    await startRun(gate, makeSteps(app, { pick: pick("SELECT :id -- A") }));
    // B (分割待ち。ここで受付票を取る)
    const splitB = deferred<PendingRun | null>();
    let ticketB: RunTicket | null = null;
    const b = startRun(
      gate,
      makeSteps(app, {
        pick: (ticket) => {
          ticketB = ticket;
          return splitB.promise;
        },
      })
    );

    // 取り消し・確定
    app.dropRuns("A");
    savedA.settle({});
    await app.settled();

    splitB.settle({
      ticket: ticketB as unknown as RunTicket,
      sql: "SELECT :id -- B",
      transaction: false,
      capture: false,
    });
    await b;
    await app.settled();

    expect(app.dialogs).toHaveLength(0);
    expect(app.ran).toHaveLength(0);
  });

  it("準備の途中でタブを閉じたら、画面も実行依頼も出ない", async () => {
    const saved = deferred<Record<string, { value: string; kind: string }>>();
    const app = makeApp({
      saved: () => saved.promise,
      inferKind: async () => "auto",
    });
    app.show("A");
    await startRun(createRunGate(), makeSteps(app, { pick: pick("SELECT :id") }));
    app.closeTab("A");
    saved.settle({});
    await app.settled();

    expect(app.dialogs).toHaveLength(0);
    expect(app.ran).toHaveLength(0);
  });

  it("パラメータの無い新しい実行は、古い準備を無効にする", async () => {
    const savedA = deferred<Record<string, { value: string; kind: string }>>();
    const app = makeApp({
      saved: () => savedA.promise,
      inferKind: async () => "auto",
    });
    app.show("A");
    const gate = createRunGate();

    await startRun(gate, makeSteps(app, { pick: pick("SELECT :id") }));
    await startRun(gate, makeSteps(app, { pick: pick("SELECT 1") }));
    savedA.settle({});
    await app.settled();

    expect(app.ran.map((r) => r.sql)).toEqual(["SELECT 1"]);
    expect(app.dialogs).toHaveLength(0);
  });

  it("取り消しのあと、新しく押した実行は通る", async () => {
    const app = app1();
    const gate = createRunGate();
    await startRun(gate, makeSteps(app, { pick: pick("SELECT :id") }));
    await app.settled();
    app.dropRuns("A");

    await startRun(gate, makeSteps(app, { pick: pick("SELECT :id -- 次") }));
    await app.settled();
    expect(app.dialogs.map((d) => d.sql)).toEqual([
      "SELECT :id",
      "SELECT :id -- 次",
    ]);
  });

  it("確認を出したあと、続行すると1回だけ実行を依頼する", async () => {
    /*
     * 続行は「同じ受付票で実行を依頼する」だけで、番号は捨てない
     * (捨てると、その続行自体が古い扱いになってしまう)。
     * 二度押しを防いでいるのは確認画面が閉じることで、そこはReact側の話
     */
    const app = app1();
    let pending: PendingRun | null = null;
    await startRun(
      createRunGate(),
      makeSteps(app, {
        pick: pick("SELECT 1"),
        check: async () => [
          { definitionChange: false, kind: "危険", sql: "SELECT 1" },
        ],
        confirm: (_stmts, run) => {
          pending = run;
        },
      })
    );
    expect(app.ran).toHaveLength(0);

    const go = pending as PendingRun | null;
    if (go) app.onRun(go);
    await app.settled();
    expect(app.ran).toHaveLength(1);
    expect(app.ran[0].key).toBe("A");
  });

  it("空SQL・判定失敗・実行後でも、次の実行を受け付ける", async () => {
    const app = app1();
    const gate = createRunGate();

    await startRun(gate, makeSteps(app, { pick: async () => null }));
    await startRun(
      gate,
      makeSteps(app, {
        pick: pick("SELECT 1"),
        check: () => Promise.reject(new Error("つながらない")),
      })
    );
    await app.settled();
    expect(app.ran.map((r) => r.sql)).toEqual(["SELECT 1"]);

    await startRun(gate, makeSteps(app, { pick: pick("SELECT 2") }));
    await app.settled();
    expect(app.ran.map((r) => r.sql)).toEqual(["SELECT 1", "SELECT 2"]);
  });
});
