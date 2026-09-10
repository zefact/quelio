import { describe, expect, it } from "vitest";
import { topicsFor } from "./helpTopics";

describe("出せる話題", () => {
  it("MySQLとPostgreSQLでは照合順序を出す", () => {
    for (const db of ["mysql", "postgresql"] as const) {
      expect(topicsFor(db).map((t) => t.id)).toContain("collation");
    }
  });

  it("SQLiteとValkeyでは照合順序を出さない", () => {
    for (const db of ["sqlite", "valkey"] as const) {
      expect(topicsFor(db).map((t) => t.id)).not.toContain("collation");
    }
  });

  it("どの話題にも見出しと中身がある", () => {
    for (const db of ["mysql", "postgresql"] as const) {
      for (const t of topicsFor(db)) {
        expect(t.label, t.id).not.toBe("");
        const secs = t.sections(db);
        expect(secs.length, t.id).toBeGreaterThan(0);
        for (const s of secs) {
          expect(s.title, t.id).not.toBe("");
          expect(s.lines.length, `${t.id} / ${s.title}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("MySQLとPostgreSQLで中身を出し分ける", () => {
    const my = topicsFor("mysql")[0].sections("mysql");
    const pg = topicsFor("postgresql")[0].sections("postgresql");
    const text = (v: typeof my) => v.map((s) => s.lines.join("")).join("");
    // MySQL 側にだけ出るもの / PostgreSQL 側にだけ出るもの
    expect(text(my)).toContain("utf8mb4");
    expect(text(pg)).not.toContain("utf8mb4");
    expect(text(pg)).toContain("LC_COLLATE");
    expect(text(my)).not.toContain("LC_COLLATE");
  });

  it("見出しは話題の中で重ならない (キーに使うため)", () => {
    for (const db of ["mysql", "postgresql"] as const) {
      for (const t of topicsFor(db)) {
        const titles = t.sections(db).map((s) => s.title);
        expect(new Set(titles).size, t.id).toBe(titles.length);
      }
    }
  });
});
