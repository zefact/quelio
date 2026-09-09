import { describe, expect, it } from "vitest";
import {
  SCOPE_HELP,
  noteFor,
  readOnlyPrivileges,
  rules,
  screenNotes,
} from "./dbUserHelp";

describe("権限の意味", () => {
  it("よく使うものには説明がある", () => {
    for (const p of ["SELECT", "USAGE", "ALL PRIVILEGES", "CREATE USER"]) {
      expect(noteFor(p)).not.toBe("");
    }
  });

  it("大小を気にしない", () => {
    expect(noteFor("select")).toBe(noteFor("SELECT"));
  });

  it("知らないものは空にする (吹き出しを出さない)", () => {
    expect(noteFor("なにか")).toBe("");
  });

  it("USAGE はDBで意味が違うので、説明も変える", () => {
    // MySQL は「権限が無い」という印
    expect(noteFor("USAGE", false)).toContain("権限が無い");
    // PostgreSQL は本物の権限
    expect(noteFor("USAGE", true)).toContain("使えるように");
    expect(noteFor("USAGE", false)).not.toBe(noteFor("USAGE", true));
  });
});

describe("付け外しできない権限", () => {
  it("MySQLのUSAGEは説明だけ出す", () => {
    expect(readOnlyPrivileges(false)).toEqual(["USAGE"]);
    expect(readOnlyPrivileges(true)).toEqual([]);
  });
});

describe("DBの決まり", () => {
  it("つないでいる側のぶんだけを返す", () => {
    const my = rules(false);
    const pg = rules(true);
    expect(my.length).toBe(pg.length);
    // 同じ見出しで、中身だけが入れ替わる
    expect(my.map((r) => r.about)).toEqual(pg.map((r) => r.about));
    for (const [i, row] of my.entries()) {
      expect(row.text).not.toBe(pg[i].text);
    }
  });

  it("どの行にも見出しと中身がある", () => {
    for (const row of [...rules(false), ...rules(true)]) {
      expect(row.about).not.toBe("");
      expect(row.text).not.toBe("");
    }
  });

  it("MySQLの説明にPostgreSQLの話を混ぜない", () => {
    const my = rules(false)
      .map((r) => r.text)
      .join();
    expect(my).not.toContain("PostgreSQL");
    expect(my).not.toContain("pg_hba");
    expect(my).not.toContain("NOLOGIN");
  });

  it("PostgreSQLの説明にMySQLの話を混ぜない", () => {
    const pg = rules(true)
      .map((r) => r.text)
      .join();
    expect(pg).not.toContain("MySQL");
    expect(pg).not.toContain("MariaDB");
    expect(pg).not.toContain("ACCOUNT LOCK");
  });
});

describe("この画面での扱い", () => {
  it("どちらのDBでも共通の約束が入る", () => {
    for (const notes of [screenNotes(false), screenNotes(true)]) {
      expect(notes.join()).toContain("読むだけ");
      expect(notes.join()).toContain("自分自身");
    }
  });

  it("MySQLだけの注意が足される", () => {
    expect(screenNotes(false).length).toBeGreaterThan(
      screenNotes(true).length
    );
    expect(screenNotes(false).join()).toContain("存在しないデータベース");
  });
});

describe("範囲の説明", () => {
  it("すべての範囲に説明がある", () => {
    for (const key of [
      "server",
      "database",
      "schema",
      "table",
      "column",
      "default",
    ] as const) {
      expect(SCOPE_HELP[key]).not.toBe("");
    }
  });
});
