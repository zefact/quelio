import { describe, expect, it } from "vitest";
import { add, current, expired, merge, remove, tick } from "./aiApproval";
import type { AiApproval } from "./aiApproval";

const item = (id: string, remainingSecs = 120): AiApproval => ({
  requestId: id,
  connection: "開発DB",
  env: "dev",
  database: "appdb",
  sql: "UPDATE users SET name = 'a' WHERE id = 1",
  dangerous: [],
  remainingSecs,
});

describe("待ち行列", () => {
  it("何も無ければ出すものは無い", () => {
    expect(current([])).toBeNull();
  });

  it("先に来たものから出す", () => {
    const q = add(add([], item("a")), item("b"));
    expect(current(q)?.requestId).toBe("a");
  });

  it("同じ目印は二重に並ばない", () => {
    // イベントと取り直しの両方から同じものが来る
    const q = add(add([], item("a")), item("a"));
    expect(q).toHaveLength(1);
  });

  it("答えたら次が出る", () => {
    const q = add(add([], item("a")), item("b"));
    expect(current(remove(q, "a"))?.requestId).toBe("b");
  });

  it("知らない目印を外しても壊れない", () => {
    const q = add([], item("a"));
    expect(remove(q, "ありません")).toHaveLength(1);
  });

  it("取り直した一覧は、知らないものだけ足す", () => {
    const q = add([], item("a"));
    const merged = merge(q, [item("a"), item("b")]);
    expect(merged.map((m) => m.requestId)).toEqual(["a", "b"]);
  });

  it("残り秒数は1つずつ減る", () => {
    const q = tick(add([], item("a", 3)));
    expect(q[0].remainingSecs).toBe(2);
  });

  it("0より下へは行かない", () => {
    const q = tick(add([], item("a", 0)));
    expect(q[0].remainingSecs).toBe(0);
  });

  it("残り0のものを時間切れとして拾える", () => {
    const q = merge([], [item("a", 0), item("b", 5)]);
    expect(expired(q).map((e) => e.requestId)).toEqual(["a"]);
  });

  it("時間切れを外したあとは、もう時間切れとして拾われない", () => {
    /*
     * 通知が二重に出ないことの裏付け。
     * 「減らす」と「時間切れを知らせて外す」を分けてあるので、
     * 外したあとの行列には時間切れが残らない (= もう一度は知らせない)
     */
    const q = merge([], [item("a", 1), item("b", 5)]);
    const ticked = tick(q);
    const done = expired(ticked);
    expect(done).toHaveLength(1);
    const after = done.reduce((acc, d) => remove(acc, d.requestId), ticked);
    expect(expired(after)).toHaveLength(0);
    expect(after.map((a) => a.requestId)).toEqual(["b"]);
  });
});
