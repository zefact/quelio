import { describe, expect, it } from "vitest";
import { afterConfirm, afterDangerCheck, confirmTarget } from "./queryGuard";
import type { PendingRun } from "./queryGuard";
import type { DangerousStatement } from "../types/query";

const danger: DangerousStatement = {
  definitionChange: false,
  kind: "WHERE の無い UPDATE",
  sql: "UPDATE users SET name = 'x'",
};

/** 実行を押した時点の中身 */
const pending: PendingRun = {
  ticket: {
    key: "t1",
    token: 1,
    db: "app",
    sheet: "s1",
    connection: "開発",
    dbType: "mysql",
  },
  sql: "UPDATE users SET name = 'x'",
  transaction: true,
  capture: true,
};

describe("afterDangerCheck", () => {
  it("危険な文が見つかれば確認を出す", () => {
    expect(afterDangerCheck([danger])).toEqual({
      kind: "confirm",
      stmts: [danger],
    });
  });

  it("見つからなければそのまま実行する", () => {
    expect(afterDangerCheck([])).toEqual({ kind: "run" });
  });

  it("判定できなかったときも実行は止めない (今の方針)", () => {
    // バックエンドと話せなかった場合。ここを変えると挙動が変わるので、
    // 方針を変えるときはこのテストごと直すことになる
    expect(afterDangerCheck(null)).toEqual({ kind: "run" });
  });
});

describe("afterConfirm", () => {
  it("続行すると、保留していたSQLと設定をそのまま実行する", () => {
    // 確認している間にエディタを書き換えられても、確認したものが走る
    expect(afterConfirm(pending, true)).toEqual(pending);
  });

  it("やめると実行しない", () => {
    expect(afterConfirm(pending, false)).toBeNull();
  });

  it("保留が無ければ実行しない", () => {
    // 閉じたあとに返事が届いた場合 (二重クリックなど)
    expect(afterConfirm(null, true)).toBeNull();
  });
});

describe("confirmTarget", () => {
  it("確認に出す対象は、実行に使う受付票から取る", () => {
    expect(confirmTarget(pending)).toEqual({
      connection: "開発",
      database: "app",
      dbType: "mysql",
      transaction: true,
    });
  });

  it("押した後に別の接続へ切り替えても、受付票の対象のまま", () => {
    /*
     * 受付票は押した瞬間の接続を持っている。
     * 画面が別の接続を表示していても、ここから取る限り食い違わない
     */
    const other = {
      ...pending,
      ticket: {
        ...pending.ticket,
        key: "t2",
        connection: "本番",
        db: "shop",
        dbType: "postgresql" as const,
      },
    };
    expect(confirmTarget(other)).toEqual({
      connection: "本番",
      database: "shop",
      dbType: "postgresql",
      transaction: true,
    });
  });

  it("データベースを選んでいなければ出さない", () => {
    const noDb = { ...pending, ticket: { ...pending.ticket, db: null } };
    expect(confirmTarget(noDb).database).toBeUndefined();
  });

  it("トランザクションは押した時点の設定", () => {
    const off = { ...pending, transaction: false };
    expect(confirmTarget(off).transaction).toBe(false);
  });
});
