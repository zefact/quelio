import { describe, expect, it } from "vitest";
import { scopeAt } from "./sqlScope";

/** テスト用のスキーマ */
const SCHEMA: Record<string, string[]> = {
  users: ["id", "name", "email"],
  orders: ["id", "user_id", "total"],
  items: ["id", "order_id", "sku", "qty"],
};

const columnsOf = (t: string) => SCHEMA[t.toLowerCase()] ?? null;

/** `|` の位置をカーソルとして scopeAt を呼ぶ */
function at(sqlWithCaret: string) {
  const pos = sqlWithCaret.indexOf("|");
  const sql = sqlWithCaret.replace("|", "");
  return scopeAt(sql, pos, columnsOf);
}

/** その場所から見えている列名 */
function visible(sqlWithCaret: string): string[] {
  const scope = at(sqlWithCaret);
  const out: string[] = [];
  for (const s of scope.sources) {
    const cols = s.columns ?? (s.table ? columnsOf(s.table) : null);
    if (cols) out.push(...cols);
  }
  return [...new Set(out)];
}

describe("scopeAt — ふつうの問い合わせ", () => {
  it("FROMのテーブルが見える", () => {
    expect(at("select | from users").sources).toEqual([
      { alias: "", table: "users", columns: null },
    ]);
  });

  it("別名を覚える", () => {
    expect(at("select | from users u").sources[0]).toEqual({
      alias: "u",
      table: "users",
      columns: null,
    });
  });

  it("AS付きの別名も覚える", () => {
    expect(at("select | from users as u").sources[0].alias).toBe("u");
  });

  it("JOINしたテーブルも見える", () => {
    const tables = at(
      "select | from users u join orders o on o.user_id = u.id"
    ).sources.map((s) => s.table);
    expect(tables).toEqual(["users", "orders"]);
  });

  it("カンマ区切りのFROMも読む", () => {
    const tables = at("select | from users u, orders o").sources.map(
      (s) => s.table
    );
    expect(tables).toEqual(["users", "orders"]);
  });

  it("予約語を別名にしない", () => {
    expect(at("select | from users where id = 1").sources[0].alias).toBe("");
  });
});

describe("scopeAt — WITH句", () => {
  const sql = `
    with recent as (
      select id, user_id, total from orders where total > 100
    )
    select | from recent r
  `;

  it("WITH句の名前を覚える", () => {
    expect(at(sql).cteNames).toContain("recent");
  });

  it("WITH句が返す列が見える", () => {
    expect(visible(sql)).toEqual(["id", "user_id", "total"]);
  });

  it("WITH句の中の * は元のテーブルの列に開く", () => {
    expect(
      visible("with a as (select * from users) select | from a")
    ).toEqual(["id", "name", "email"]);
  });

  it("WITH x(a, b) の列名を使う", () => {
    expect(
      visible("with a(x, y) as (select id, name from users) select | from a")
    ).toEqual(["x", "y"]);
  });

  it("WITH句を複数書ける", () => {
    const two = `with a as (select id from users),
                      b as (select sku from items)
                 select | from a join b on 1 = 1`;
    expect(visible(two)).toEqual(["id", "sku"]);
    expect(at(two).cteNames).toEqual(["a", "b"]);
  });

  it("後のWITH句が前のWITH句を使える", () => {
    const sql = `with a as (select id, name from users),
                      b as (select name from a)
                 select | from b`;
    expect(visible(sql)).toEqual(["name"]);
  });
});

describe("scopeAt — 導出表", () => {
  it("FROM (...) の別名と列を割り出す", () => {
    const sql = "select | from (select id, name from users) u";
    expect(at(sql).sources[0]).toEqual({
      alias: "u",
      table: "",
      columns: ["id", "name"],
    });
  });

  it("式には別名から列名を取る", () => {
    const sql =
      "select | from (select count(*) as cnt, sum(total) total from orders) t";
    expect(visible(sql)).toEqual(["cnt", "total"]);
  });

  it("名前の無い式は列にしない", () => {
    const sql = "select | from (select id, total * 2 from orders) t";
    expect(visible(sql)).toEqual(["id"]);
  });

  it("t.* は そのテーブルの列に開く", () => {
    const sql =
      "select | from (select u.*, o.total from users u join orders o on 1=1) x";
    expect(visible(sql)).toEqual(["id", "name", "email", "total"]);
  });

  it("入れ子の導出表も追える", () => {
    const sql =
      "select | from (select a.name from (select name from users) a) b";
    expect(visible(sql)).toEqual(["name"]);
  });
});

describe("scopeAt — 副問い合わせの中", () => {
  it("内側のFROMが見える", () => {
    const sql = "select * from orders o where o.id in (select | from items i)";
    expect(at(sql).sources[0].table).toBe("items");
  });

  it("外側の別名も残る (相関副問い合わせ)", () => {
    const sql = "select * from orders o where o.id in (select | from items i)";
    const tables = at(sql).sources.map((s) => s.table);
    expect(tables).toEqual(["items", "orders"]);
  });

  it("内側が先に来る", () => {
    const sql = "select * from users u where exists (select | from orders u)";
    expect(at(sql).sources[0].table).toBe("orders");
  });
});

describe("scopeAt — 壊れにくさ", () => {
  it("書きかけでも落ちない", () => {
    expect(() => at("select | from")).not.toThrow();
    expect(() => at("with a as (select | ")).not.toThrow();
    expect(() => at("select * from ((((|")).not.toThrow();
  });

  it("コメントの中のFROMは拾わない", () => {
    const sql = "-- select * from items\nselect | from users";
    expect(at(sql).sources.map((s) => s.table)).toEqual(["users"]);
  });

  it("文字列の中のFROMは拾わない", () => {
    const sql = "select | from users where name = 'from orders'";
    expect(at(sql).sources.map((s) => s.table)).toEqual(["users"]);
  });

  it("UNIONはカーソルのある側を見る", () => {
    const sql = "select id from users union select | from orders";
    expect(at(sql).sources.map((s) => s.table)).toEqual(["orders"]);
  });

  it("UPDATE / INSERT の対象も取得元にする", () => {
    expect(at("update users set | ").sources[0].table).toBe("users");
    expect(at("insert into users (|) values (1)").sources[0].table).toBe(
      "users"
    );
  });
});
