import { describe, expect, it } from "vitest";
import {
  pinnedConnections,
  recentConnections,
  sinceLabel,
} from "./recentConnections";
import type { ConnectionProfile } from "./types";

function conn(p: Partial<ConnectionProfile>): ConnectionProfile {
  return {
    id: "x",
    name: "x",
    dbType: "mysql",
    host: "localhost",
    port: 3306,
    user: "root",
    password: "",
    ...p,
  };
}

const list = [
  conn({ id: "a", lastUsedAt: "2026-08-01T10:00:00.000Z" }),
  conn({ id: "b", pinned: true, lastUsedAt: "2026-08-03T10:00:00.000Z" }),
  conn({ id: "c", lastUsedAt: "2026-08-05T10:00:00.000Z" }),
  conn({ id: "d" }),
  conn({ id: "e", pinned: true }),
];

describe("ホームに出す接続", () => {
  it("ピン留めは一覧の並び順のまま出す", () => {
    expect(pinnedConnections(list).map((c) => c.id)).toEqual(["b", "e"]);
  });

  it("最近つないだ順に並べる", () => {
    expect(recentConnections(list).map((c) => c.id)).toEqual(["c", "a"]);
  });

  it("ピン留めしたものは最近には出さない (二重に出さない)", () => {
    expect(recentConnections(list).map((c) => c.id)).not.toContain("b");
  });

  it("一度も繋いでいないものは出さない", () => {
    expect(recentConnections(list).map((c) => c.id)).not.toContain("d");
  });

  it("上限で打ち切る", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      conn({ id: `r${i}`, lastUsedAt: `2026-08-0${(i % 9) + 1}T00:00:00.000Z` })
    );
    expect(recentConnections(many, 3).length).toBe(3);
  });
});

describe("経過の表示", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");

  it("単位を切り替える", () => {
    expect(sinceLabel("2026-08-31T11:59:40.000Z", now)).toBe("たった今");
    expect(sinceLabel("2026-08-31T11:30:00.000Z", now)).toBe("30分前");
    expect(sinceLabel("2026-08-31T09:00:00.000Z", now)).toBe("3時間前");
    expect(sinceLabel("2026-08-28T12:00:00.000Z", now)).toBe("3日前");
    expect(sinceLabel("2026-06-01T12:00:00.000Z", now)).toBe("3か月前");
    expect(sinceLabel("2024-08-31T12:00:00.000Z", now)).toBe("2年前");
  });

  it("読めない値なら何も出さない", () => {
    expect(sinceLabel(undefined, now)).toBe("");
    expect(sinceLabel("こわれた値", now)).toBe("");
  });
});
