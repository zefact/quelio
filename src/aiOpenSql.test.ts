import { describe, expect, it } from "vitest";

import * as q from "./aiOpenSql";

function req(id: string, profileId = "p1"): q.OpenSqlEvent {
  return {
    id,
    profileId,
    connection: "開発DB",
    database: null,
    sql: "select 1",
    title: "AIの提案 1",
  };
}

function tab(over: Partial<q.TabRef> = {}): q.TabRef {
  return {
    key: "t1",
    profileId: "p1",
    connected: true,
    running: false,
    connecting: false,
    ...over,
  };
}

describe("add", () => {
  it("同じ番号は二度預からない", () => {
    const one = q.add([], req("a"), 0);
    expect(q.add(one, req("a"), 5)).toBe(one);
  });

  it("上限を超えたら古いものから捨てる", () => {
    let queue: q.Queued[] = [];
    for (let i = 0; i < q.MAX_QUEUED + 2; i += 1) {
      queue = q.add(queue, req(`r${i}`), i);
    }
    expect(queue).toHaveLength(q.MAX_QUEUED);
    expect(queue[0].req.id).toBe("r2");
  });
});

describe("drain", () => {
  it("繋がっているタブへ置く", () => {
    const queue = q.add([], req("a"), 0);
    const got = q.drain(queue, [tab()], 0);
    expect(got.ready).toEqual([{ key: "t1", req: queue[0].req }]);
    expect(got.rest).toEqual([]);
  });

  it("未接続のタブには置かず預かったままにする", () => {
    const queue = q.add([], req("a"), 0);
    const got = q.drain(queue, [tab({ connected: false })], 0);
    expect(got.ready).toEqual([]);
    expect(got.rest).toEqual(queue);
  });

  it("実行中のタブには置かない（結果の行き先が変わるため）", () => {
    const queue = q.add([], req("a"), 0);
    const got = q.drain(queue, [tab({ running: true })], 0);
    expect(got.ready).toEqual([]);
    expect(got.rest).toEqual(queue);
  });

  it("別の接続のタブには置かない", () => {
    const queue = q.add([], req("a", "p9"), 0);
    expect(q.drain(queue, [tab()], 0).ready).toEqual([]);
  });

  it("時間切れのものは捨てて、捨てたことを返す", () => {
    const queue = q.add([], req("a"), 0);
    const got = q.drain(queue, [tab({ connected: false })], q.EXPIRE_MS);
    expect(got.ready).toEqual([]);
    expect(got.rest).toEqual([]);
    expect(got.dropped.map((d) => d.id)).toEqual(["a"]);
  });

  it("期限切れでも接続中なら捨てない", () => {
    // 本番の確認ダイアログを長く開いたままにしてから接続したとき
    const queue = q.markTried(q.add([], req("a"), 0), "p1");
    const got = q.drain(
      queue,
      [tab({ connected: false, connecting: true })],
      q.EXPIRE_MS * 2,
    );
    expect(got.dropped).toEqual([]);
    expect(got.rest).toEqual(queue);
  });

  it("実行中のタブを待っている間も期限切れにはしない", () => {
    const queue = q.add([], req("a"), 0);
    const got = q.drain(queue, [tab({ running: true })], q.EXPIRE_MS * 2);
    expect(got.dropped).toEqual([]);
    expect(got.rest).toEqual(queue);
  });

  it("接続の手続き中なら待つ", () => {
    const queue = q.markTried(q.add([], req("a"), 0), "p1");
    const got = q.drain(queue, [tab({ connected: false, connecting: true })], 0);
    expect(got.rest).toEqual(queue);
    expect(got.dropped).toEqual([]);
  });

  it("繋ぎにいったのに手が空いていれば、失敗とみなして捨てる", () => {
    const queue = q.markTried(q.add([], req("a"), 0), "p1");
    // 確認ダイアログを取り消した / パスワードを間違えた後の状態
    const got = q.drain(queue, [tab({ connected: false })], 0);
    expect(got.ready).toEqual([]);
    expect(got.rest).toEqual([]);
    expect(got.dropped.map((d) => d.id)).toEqual(["a"]);
  });

  it("まだ繋ぎにいっていなければ捨てない", () => {
    const queue = q.add([], req("a"), 0);
    const got = q.drain(queue, [], 0);
    expect(got.dropped).toEqual([]);
    expect(got.rest).toEqual(queue);
  });

  it("同じ接続に複数溜まっていれば順に置く", () => {
    let queue = q.add([], req("a"), 0);
    queue = q.add(queue, req("b"), 1);
    const got = q.drain(queue, [tab()], 1);
    expect(got.ready.map((r) => r.req.id)).toEqual(["a", "b"]);
  });
});

describe("needsConnect", () => {
  it("繋がっているタブがある接続は返さない", () => {
    let queue = q.add([], req("a", "p1"), 0);
    queue = q.add(queue, req("b", "p2"), 0);
    expect(q.needsConnect(queue, [tab()])).toEqual(["p2"]);
  });

  it("タブはあっても未接続なら繋ぎにいく", () => {
    const queue = q.add([], req("a", "p1"), 0);
    expect(q.needsConnect(queue, [tab({ connected: false })])).toEqual(["p1"]);
  });

  it("実行中のタブは繋ぎ直さない", () => {
    const queue = q.add([], req("a", "p1"), 0);
    expect(q.needsConnect(queue, [tab({ running: true })])).toEqual([]);
  });

  it("接続の手続き中のタブには重ねて繋ぎにいかない", () => {
    const queue = q.add([], req("a", "p1"), 0);
    const connecting = tab({ connected: false, connecting: true });
    expect(q.needsConnect(queue, [connecting])).toEqual([]);
  });

  it("一度繋ぎにいったものは繰り返さない", () => {
    const queue = q.markTried(q.add([], req("a", "p1"), 0), "p1");
    expect(q.needsConnect(queue, [])).toEqual([]);
  });

  it("同じ接続は1度だけ返す", () => {
    let queue = q.add([], req("a", "p2"), 0);
    queue = q.add(queue, req("b", "p2"), 0);
    expect(q.needsConnect(queue, [])).toEqual(["p2"]);
  });
});

describe("markTried", () => {
  it("その接続の要求にだけ印を付ける", () => {
    let queue = q.add([], req("a", "p1"), 0);
    queue = q.add(queue, req("b", "p2"), 0);
    const got = q.markTried(queue, "p1");
    expect(got[0].tried).toBe(true);
    expect(got[1].tried).toBe(false);
  });
});

describe("withDatabaseNote", () => {
  it("指定が無ければ何も足さない", () => {
    expect(q.withDatabaseNote("select 1", null, false)).toBe("select 1");
  });

  it("切り替えたら対象DBを書き添える", () => {
    expect(q.withDatabaseNote("select 1", "shop", true)).toBe(
      "-- 対象DB: shop\nselect 1",
    );
  });

  it("切り替えられなかったことも書く", () => {
    expect(q.withDatabaseNote("select 1", "shop", false)).toBe(
      "-- 対象DB: shop (このタブでは選べませんでした)\nselect 1",
    );
  });
});

describe("forget", () => {
  it("その接続のぶんだけ捨てる", () => {
    let queue = q.add([], req("a", "p1"), 0);
    queue = q.add(queue, req("b", "p2"), 0);
    expect(q.forget(queue, "p1").map((x) => x.req.id)).toEqual(["b"]);
  });
});
