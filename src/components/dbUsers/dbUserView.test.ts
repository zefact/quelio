import { describe, expect, it } from "vitest";
import type { DbGrant, DbUser } from "../../types";
import {
  blockedReason,
  filterUsers,
  groupGrants,
  privilegeSummary,
  revokeNote,
  revokeSpec,
  userLabel,
  userRef,
} from "./dbUserView";

function grant(
  scope: DbGrant["scope"],
  target: string,
  privilege: string,
  grantable = false
): DbGrant {
  return { scope, target, privilege, grantable };
}

function user(name: string, over: Partial<DbUser> = {}): DbUser {
  return {
    name,
    host: "",
    key: name,
    canLogin: true,
    superuser: false,
    system: false,
    isSelf: false,
    badges: [],
    memberOf: [],
    connLimit: "",
    expires: "",
    auth: "",
    ...over,
  };
}

describe("権限のまとめ方", () => {
  it("同じ対象は1行にまとめる", () => {
    const out = groupGrants([
      grant("table", "s1.t1", "SELECT"),
      grant("table", "s1.t1", "INSERT"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].privileges).toEqual(["INSERT", "SELECT"]);
  });

  it("広い範囲から順に並べる", () => {
    const out = groupGrants([
      grant("column", "s1.t1.a", "SELECT"),
      grant("server", "*.*", "PROCESS"),
      grant("table", "s1.t1", "SELECT"),
      grant("database", "db", "SELECT"),
    ]);
    expect(out.map((g) => g.scope)).toEqual([
      "server",
      "database",
      "table",
      "column",
    ]);
  });

  it("同じ範囲の中は対象の名前順", () => {
    const out = groupGrants([
      grant("table", "s1.b", "SELECT"),
      grant("table", "s1.a", "SELECT"),
    ]);
    expect(out.map((g) => g.target)).toEqual(["s1.a", "s1.b"]);
  });

  it("1つでも渡せるなら渡せる印を付ける", () => {
    const out = groupGrants([
      grant("table", "s1.t1", "SELECT", false),
      grant("table", "s1.t1", "INSERT", true),
    ]);
    expect(out[0].grantable).toBe(true);
  });

  it("同じ権限が二重に来ても増やさない", () => {
    const out = groupGrants([
      grant("table", "s1.t1", "SELECT"),
      grant("table", "s1.t1", "SELECT"),
    ]);
    expect(out[0].privileges).toEqual(["SELECT"]);
  });
});

describe("一覧の絞り込み", () => {
  const list = [
    user("app", { host: "%", memberOf: ["readers"] }),
    user("mariadb.sys", { host: "localhost", system: true }),
    user("me", { isSelf: true, system: true }),
    user("batch", { badges: ["管理者"] }),
  ];

  it("既定ではサーバーが用意したものを外す", () => {
    expect(filterUsers(list, "", false).map((u) => u.name)).toEqual([
      "app",
      "me",
      "batch",
    ]);
  });

  it("今つないでいるユーザーは常に残す", () => {
    const only = filterUsers(list, "", false).find((u) => u.isSelf);
    expect(only?.name).toBe("me");
  });

  it("出す指定なら全部残す", () => {
    expect(filterUsers(list, "", true)).toHaveLength(4);
  });

  it("名前・接続元・ロール・印から探せる", () => {
    expect(filterUsers(list, "readers", false).map((u) => u.name)).toEqual([
      "app",
    ]);
    expect(filterUsers(list, "管理者", false).map((u) => u.name)).toEqual([
      "batch",
    ]);
    expect(filterUsers(list, "%", false).map((u) => u.name)).toEqual(["app"]);
  });
});

describe("見出し", () => {
  it("接続元があれば付ける", () => {
    expect(userLabel(user("app", { host: "%" }))).toBe("app@%");
    expect(userLabel(user("app"))).toBe("app");
  });
});

describe("取り消しの指定", () => {
  it("サーバー全体は対象を書かない", () => {
    const [g] = groupGrants([grant("server", "*.*", "PROCESS")]);
    expect(revokeSpec(g)).toEqual({
      scope: "server",
      target: "",
      privileges: ["PROCESS"],
      grantable: false,
    });
  });

  it("データベースとテーブルは対象をそのまま渡す", () => {
    const [d] = groupGrants([grant("database", "db_a", "SELECT")]);
    expect(revokeSpec(d)?.target).toBe("db_a");
    const [t] = groupGrants([grant("table", "s1.t1", "SELECT")]);
    expect(revokeSpec(t)?.target).toBe("s1.t1");
  });

  it("まとめた権限はまとめて外す", () => {
    const [g] = groupGrants([
      grant("database", "db_a", "SELECT"),
      grant("database", "db_a", "INSERT"),
    ]);
    expect(revokeSpec(g)?.privileges).toEqual(["INSERT", "SELECT"]);
  });

  it("渡せる印も一緒に外す指定にする", () => {
    const [g] = groupGrants([grant("database", "db_a", "SELECT", true)]);
    expect(revokeSpec(g)?.grantable).toBe(true);
    const [plain] = groupGrants([grant("database", "db_a", "SELECT")]);
    expect(revokeSpec(plain)?.grantable).toBe(false);
  });

  it("USAGEだけでも渡せる印が残っていれば外せる", () => {
    const [g] = groupGrants([grant("server", "*.*", "USAGE", true)]);
    const spec = revokeSpec(g, false);
    expect(spec?.grantable).toBe(true);
  });

  it("MySQLのサーバー全体のUSAGEは外せない", () => {
    const [g] = groupGrants([grant("server", "*.*", "USAGE")]);
    expect(revokeSpec(g, false)).toBeNull();
    // ほかの権限が一緒に付いていれば外せる
    const [both] = groupGrants([
      grant("server", "*.*", "USAGE"),
      grant("server", "*.*", "PROCESS"),
    ]);
    expect(revokeSpec(both, false)).not.toBeNull();
    // PostgreSQL の USAGE は本物の権限なので外せる
    const [pgOne] = groupGrants([grant("schema", "s1", "USAGE")]);
    expect(revokeSpec(pgOne, true)).not.toBeNull();
  });

  it("列と既定は外せない", () => {
    const [c] = groupGrants([grant("column", "s1.t1.name", "UPDATE")]);
    expect(revokeSpec(c)).toBeNull();
    const [d] = groupGrants([grant("default", "s1", "SELECT")]);
    expect(revokeSpec(d)).toBeNull();
  });
});

describe("変えてよい相手か", () => {
  it("自分自身とサーバー既定のものは断る", () => {
    expect(blockedReason(user("app"))).toBeNull();
    expect(blockedReason(user("me", { isSelf: true }))).toContain("自身");
    expect(blockedReason(user("mariadb.sys", { system: true }))).toContain(
      "サーバー"
    );
  });

  it("自分自身であることを先に見る", () => {
    const both = user("postgres", { isSelf: true, system: true });
    expect(blockedReason(both)).toContain("自身");
  });
});

describe("やり取り用の値", () => {
  it("名前と接続元だけを渡す", () => {
    expect(userRef(user("app", { host: "%" }))).toEqual({
      name: "app",
      host: "%",
    });
  });
});

describe("権限の名前をつなぐ", () => {
  it("少ないうちはそのまま並べる", () => {
    expect(privilegeSummary(["SELECT", "INSERT"])).toBe("SELECT / INSERT");
  });

  it("何も無ければ空", () => {
    expect(privilegeSummary([])).toBe("");
  });

  it("多いときは頭だけ出して残りは件数にする", () => {
    const many = Array.from({ length: 60 }, (_, i) => `P${i}`);
    const out = privilegeSummary(many);
    expect(out).toBe("P0 / P1 / P2 / P3 / P4 / P5 ほか54件");
  });

  it("ちょうど上限のときは件数を付けない", () => {
    const six = ["A", "B", "C", "D", "E", "F"];
    expect(privilegeSummary(six)).toBe("A / B / C / D / E / F");
  });
});

describe("取り消しの断り書き", () => {
  it("何を外すのかを書く", () => {
    const [g] = groupGrants([grant("database", "db_a", "SELECT")]);
    expect(revokeNote(g)).toContain("SELECT を外します");
  });

  it("渡せる印も外すときは、そう書く", () => {
    const [g] = groupGrants([grant("database", "db_a", "SELECT", true)]);
    expect(revokeNote(g)).toContain("他人に渡せる");
  });

  it("USAGEだけの行は、印だけを外すと書く", () => {
    const [g] = groupGrants([grant("server", "*.*", "USAGE", true)]);
    const note = revokeNote(g, false);
    expect(note).toContain("他人に渡せる");
    expect(note).not.toContain("USAGE");
  });
});
