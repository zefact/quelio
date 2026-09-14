import { describe, expect, it } from "vitest";
import { topicsFor } from "./helpTopics";
import type { DbType } from "../../types";
import { QUICK_SHORTCUTS, SHORTCUTS } from "../../shortcuts";

/** SQLを書くDB (DBごとに中身が変わる話は、この3つで見る) */
const DBS: DbType[] = ["mysql", "postgresql", "sqlite"];

/** つなげるDB全部 (話題の形そのものは、どれでも壊れていないこと) */
const ALL_DBS: DbType[] = [...DBS, "valkey"];

/** ある話題の中身を、文章も表もまとめて1つの文字列にする */
function textOf(dbType: DbType, id: string): string {
  const t = topicsFor(dbType).find((x) => x.id === id);
  if (!t) return "";
  return t
    .sections(dbType)
    .map(
      (s) =>
        s.title +
        (s.lines ?? []).join("") +
        (s.table
          ? s.table.head.join("") + s.table.rows.map((r) => r.join("")).join("")
          : "")
    )
    .join("");
}

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

  it("SQLを書くDBでは実行計画とインデックスを出す", () => {
    for (const db of DBS) {
      expect(topicsFor(db).map((t) => t.id), db).toContain("explain");
      expect(topicsFor(db).map((t) => t.id), db).toContain("index");
    }
  });

  it("話題の目印は重ならない (どれを選んでいるかの記憶に使うため)", () => {
    for (const db of ALL_DBS) {
      const ids = topicsFor(db).map((t) => t.id);
      expect(new Set(ids).size, db).toBe(ids.length);
    }
  });

  it("ショートカットはどのDBでも出す (DBによらない話のため)", () => {
    for (const db of ALL_DBS) {
      expect(topicsFor(db).map((t) => t.id), db).toContain("shortcut");
    }
  });

  it("Valkeyに出すのは、DBによらない話だけ", () => {
    expect(topicsFor("valkey").map((t) => t.id)).toEqual(["shortcut"]);
  });

  it("どの話題にも見出しと中身がある", () => {
    for (const db of ALL_DBS) {
      for (const t of topicsFor(db)) {
        expect(t.label, t.id).not.toBe("");
        expect(t.note, t.id).not.toBe("");
        const secs = t.sections(db);
        expect(secs.length, t.id).toBeGreaterThan(0);
        for (const s of secs) {
          const where = `${db} / ${t.id} / ${s.title}`;
          expect(s.title, t.id).not.toBe("");
          // 文章か表、どちらかは必ずある
          expect((s.lines?.length ?? 0) + (s.table ? 1 : 0), where).toBeGreaterThan(0);
          for (const line of s.lines ?? []) {
            expect(line.trim(), where).not.toBe("");
          }
        }
      }
    }
  });

  it("見出しは話題の中で重ならない (並びの目印に使うため)", () => {
    for (const db of ALL_DBS) {
      for (const t of topicsFor(db)) {
        const titles = t.sections(db).map((s) => s.title);
        expect(new Set(titles).size, `${db} / ${t.id}`).toBe(titles.length);
      }
    }
  });

  it("同じ見出しの中で同じ行を2回書かない (並びの目印に使うため)", () => {
    for (const db of ALL_DBS) {
      for (const t of topicsFor(db)) {
        for (const s of t.sections(db)) {
          const lines = s.lines ?? [];
          expect(new Set(lines).size, `${db} / ${t.id} / ${s.title}`).toBe(
            lines.length
          );
        }
      }
    }
  });

  it("表は見出しと桁数がそろっていて、1列目が重ならない", () => {
    for (const db of ALL_DBS) {
      for (const t of topicsFor(db)) {
        for (const s of t.sections(db)) {
          const tbl = s.table;
          if (!tbl) continue;
          const where = `${db} / ${t.id} / ${s.title}`;
          expect(tbl.head.length, where).toBeGreaterThan(1);
          expect(tbl.rows.length, where).toBeGreaterThan(0);
          for (const row of tbl.rows) {
            // 桁がずれると、意味の列が見出しとちぐはぐになる
            expect(row.length, `${where} / ${row[0]}`).toBe(tbl.head.length);
            for (const cell of row) {
              expect(cell.trim(), `${where} / ${row[0]}`).not.toBe("");
            }
          }
          // 1列目 (用語) を行の目印に使うので、重ならないこと
          const terms = tbl.rows.map((r) => r[0]);
          expect(new Set(terms).size, where).toBe(terms.length);
        }
      }
    }
  });
});

describe("照合順序", () => {
  it("MySQLとPostgreSQLで中身を出し分ける", () => {
    const my = textOf("mysql", "collation");
    const pg = textOf("postgresql", "collation");
    expect(my).toContain("utf8mb4");
    expect(pg).not.toContain("utf8mb4");
    expect(pg).toContain("LC_COLLATE");
    expect(my).not.toContain("LC_COLLATE");
  });
});

describe("インデックス", () => {
  it("言葉の説明は表にする (文章で並べない)", () => {
    for (const db of DBS) {
      const t = topicsFor(db).find((x) => x.id === "index");
      const tables = (t?.sections(db) ?? []).filter((s) => s.table);
      expect(tables.length, db).toBeGreaterThanOrEqual(3);
    }
  });

  it("DBごとに、そのDBで作れる種類を書く", () => {
    const my = textOf("mysql", "index");
    const pg = textOf("postgresql", "index");
    const lite = textOf("sqlite", "index");
    // MySQLは全文・空間と、InnoDBのクラスタ索引の話が要る
    expect(my).toContain("FULLTEXT");
    expect(my).toContain("InnoDB");
    // PostgreSQLは索引の種類が多く、INCLUDE と CONCURRENTLY が肝心
    expect(pg).toContain("BRIN");
    expect(pg).toContain("INCLUDE");
    expect(pg).toContain("CONCURRENTLY");
    // SQLiteは rowid の話が土台
    expect(lite).toContain("rowid");
    expect(lite).toContain("WITHOUT ROWID");
  });

  it("そのDBに無い機能を、あるかのように書かない", () => {
    const my = textOf("mysql", "index");
    const pg = textOf("postgresql", "index");
    const lite = textOf("sqlite", "index");
    // BRIN / GIN は PostgreSQL だけ
    expect(my).not.toContain("BRIN");
    expect(lite).not.toContain("BRIN");
    // FULLTEXT (MySQLの書き方) は他に出さない
    expect(pg).not.toContain("FULLTEXT");
    expect(lite).not.toContain("FULLTEXT");
    // SQLite に INCLUDE は無い。触れるなら「無い」と書く
    expect(lite).toContain("INCLUDE はない");
  });

  it("外部キーの索引が自動で付くかを、DBごとに正しく書く", () => {
    // MySQL系は自動で作る / PostgreSQLは作らない。どちらも触れておく
    expect(textOf("mysql", "index")).toContain("自動で作ります");
    expect(textOf("postgresql", "index")).toContain("自動では作りません");
  });
});

describe("実行計画", () => {
  it("言葉の説明は表にする (文章で並べない)", () => {
    for (const db of DBS) {
      const t = topicsFor(db).find((x) => x.id === "explain");
      const tables = (t?.sections(db) ?? []).filter((s) => s.table);
      expect(tables.length, db).toBeGreaterThanOrEqual(3);
    }
  });

  it("DBごとに、そのDBの言葉で書く", () => {
    const my = textOf("mysql", "explain");
    const pg = textOf("postgresql", "explain");
    const lite = textOf("sqlite", "explain");
    // MySQLは表で出るので、列の名前が要る
    expect(my).toContain("possible_keys");
    expect(my).toContain("Using filesort");
    // PostgreSQLは木で出るので、コストと実測の読み方が要る
    expect(pg).toContain("Seq Scan");
    expect(pg).toContain("loops");
    // SQLiteは SCAN / SEARCH の見分けが肝心
    expect(lite).toContain("SEARCH");
    expect(lite).toContain("COVERING INDEX");
  });

  it("他のDBの言葉を混ぜない", () => {
    const my = textOf("mysql", "explain");
    const pg = textOf("postgresql", "explain");
    const lite = textOf("sqlite", "explain");
    expect(my).not.toContain("Seq Scan");
    expect(pg).not.toContain("possible_keys");
    expect(lite).not.toContain("possible_keys");
    expect(lite).not.toContain("Seq Scan");
  });

  it("実測が取れるかどうかを、DBごとに正しく書く", () => {
    // SQLite には実測を出す仕組みが無いので、その旨が要る
    expect(textOf("sqlite", "explain")).toContain("EXPLAIN ANALYZE");
    // MySQL / PostgreSQL は参照系だけという制限がある
    for (const db of ["mysql", "postgresql"] as const) {
      expect(textOf(db, "explain"), db).toContain("参照系");
    }
  });
});

describe("ショートカット", () => {
  it("⌘/ の一覧とヘルプは、同じ元を見ている", () => {
    // 片方だけ直して食い違うことが無いよう、SHORTCUTS の一部が QUICK
    for (const g of QUICK_SHORTCUTS) {
      expect(SHORTCUTS, g.title).toContain(g);
    }
    expect(QUICK_SHORTCUTS.length).toBeGreaterThan(0);
    expect(QUICK_SHORTCUTS.length).toBeLessThan(SHORTCUTS.length);
  });

  it("キーも説明も空でなく、まとまりの中で重ならない", () => {
    for (const g of SHORTCUTS) {
      expect(g.title).not.toBe("");
      expect(g.items.length, g.title).toBeGreaterThan(0);
      const keys = g.items.map(([k]) => k);
      expect(new Set(keys).size, g.title).toBe(keys.length);
      for (const [keys2, desc] of g.items) {
        expect(keys2.trim(), g.title).not.toBe("");
        expect(desc.trim(), `${g.title} / ${keys2}`).not.toBe("");
      }
    }
  });

  it("ヘルプの話題に、すべてのまとまりが出る", () => {
    const secs = topicsFor("mysql")
      .find((t) => t.id === "shortcut")!
      .sections("mysql");
    for (const g of SHORTCUTS) {
      expect(secs.map((s) => s.title), g.title).toContain(g.title);
    }
  });
});
