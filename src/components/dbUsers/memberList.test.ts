import { describe, expect, it } from "vitest";
import type { DbUser } from "../../types";
import { memberCandidates, roleMembers } from "./memberList";

function user(name: string, o: Partial<DbUser> = {}): DbUser {
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
    ...o,
  };
}

const role = user("rext_qsc_user");
const users = [
  user("app", { memberOf: ["rext_qsc_user"] }),
  user("pg_monitor", { system: true, canLogin: false }),
  user("postgres", { isSelf: true }),
  user("reader"),
  role,
];

describe("ロールのメンバー", () => {
  it("属しているユーザーだけを出す", () => {
    expect(roleMembers(role, users).map((u) => u.name)).toEqual(["app"]);
  });

  it("足せるのは、まだ属していないユーザー (自分自身を先頭に)", () => {
    expect(memberCandidates(role, users).map((u) => u.name)).toEqual([
      "postgres",
      "reader",
    ]);
  });

  it("サーバーが用意したものとロール自身は足せない", () => {
    const names = memberCandidates(role, users).map((u) => u.name);
    expect(names).not.toContain("pg_monitor");
    expect(names).not.toContain("rext_qsc_user");
  });
});
