import { describe, expect, it } from "vitest";
import { isCurrentRun, runScope } from "./runTicket";
import type { RunTicket } from "./runTicket";
import { createReqSeq } from "./reqSeq";

const ticketOf = (key: string, token: number): RunTicket => ({
  key,
  token,
  db: "app",
  sheet: "s1",
  connection: "開発",
  dbType: "mysql",
});

describe("runScope", () => {
  it("接続タブごとに分かれる", () => {
    expect(runScope("A")).not.toBe(runScope("B"));
  });
});

describe("isCurrentRun", () => {
  it("発行元のタブの番号と突き合わせる", () => {
    const seq = createReqSeq();
    const a = ticketOf("A", seq.start(runScope("A")));
    expect(isCurrentRun(seq, a)).toBe(true);
    seq.drop(runScope("A"));
    expect(isCurrentRun(seq, a)).toBe(false);
  });

  it("別のタブの同じ番号と取り違えない", () => {
    /*
     * 番号はタブごとの連番なので、AとBの1番は別物。
     * 照合先を今見ているタブから決めると、この2つが一致してしまう
     */
    const seq = createReqSeq();
    const a = ticketOf("A", seq.start(runScope("A")));
    const b = ticketOf("B", seq.start(runScope("B")));
    expect(a.token).toBe(b.token);

    // Aだけを片付けても、Bの受付票は生きている (逆も同じ)
    seq.drop(runScope("A"));
    expect(isCurrentRun(seq, a)).toBe(false);
    expect(isCurrentRun(seq, b)).toBe(true);
  });

  it("別のタブの実行に妨げられない", () => {
    const seq = createReqSeq();
    const a = ticketOf("A", seq.start(runScope("A")));
    // Bで何度実行しても、Aの受付票は有効なまま
    seq.start(runScope("B"));
    seq.start(runScope("B"));
    expect(isCurrentRun(seq, a)).toBe(true);
  });
});
