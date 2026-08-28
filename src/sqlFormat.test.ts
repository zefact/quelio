import { describe, expect, it } from "vitest";
import { formatSql, toLeadingCommas } from "./sqlFormat";
import { defaultSqlFormat } from "./types";
import type { SqlFormatSettings } from "./types";

/** 既定から一部だけ変えた設定を作る */
function opts(patch: Partial<SqlFormatSettings> = {}): SqlFormatSettings {
  return { ...defaultSqlFormat(), ...patch };
}

const SAMPLE = "select a, b from t where a = 1 and b = 2";

describe("formatSql", () => {
  it("パラメータを含むSQLを整形できる", () => {
    /*
     * 指定を入れる前は、MySQL・SQLiteで `:name` が構文エラーになっていた。
     * パラメータ入りのSQLは整形できない、という状態だった
     */
    for (const db of ["mysql", "postgresql", "sqlite"] as const) {
      const out = formatSql("select * from t where a = :id and b = @nm", db);
      expect(out, db).toContain(":id");
      expect(out, db).toContain("@nm");
      // 名前が割られていないこと (`@ nm` になると壊れる)
      expect(out, db).not.toMatch(/[:@]\s+\w/);
    }
  });

  it("文字列の中のコロンはパラメータにしない", () => {
    const out = formatSql("select ':a' as memo, :a from t", "mysql");
    expect(out).toContain("':a'");
    expect(out).toContain(":a");
  });

  it("キーワードを大文字にして字下げする", () => {
    const out = formatSql("select a from t where b = 1", "mysql");
    expect(out.split("\n")[0]).toBe("SELECT");
    expect(out).toContain("FROM");
    expect(out).toContain("WHERE");
  });

  it("MySQLのREPLACE関数を文と取り違えない", () => {
    // REPLACE INTO と読まれると、関数なのに改行が入ってしまう
    const out = formatSql("select replace(a, 'x', 'y') from t", "mysql");
    expect(out).toContain("REPLACE(");
    expect(out).not.toMatch(/REPLACE\s*\n/);
  });

  it("整形できないSQLは例外にする", () => {
    // 閉じていない引用符など (呼び出し側でエラーを出す)
    expect(() => formatSql("select ''' from", "mysql")).toThrow();
  });
});

describe("整形の設定", () => {
  it("設定を渡さないときは、既定を渡したときと同じ形になる", () => {
    expect(formatSql(SAMPLE, "mysql")).toBe(
      formatSql(SAMPLE, "mysql", defaultSqlFormat())
    );
  });

  it("カンマの位置を行末にできる", () => {
    const out = formatSql(SAMPLE, "mysql", opts({ commaStyle: "trailing" }));
    expect(out).toContain("  a,\n");
    expect(out).not.toContain(", b");
  });

  it("キーワードを小文字・そのままにできる", () => {
    expect(formatSql(SAMPLE, "mysql", opts({ keywordCase: "lower" }))).toContain(
      "select"
    );
    expect(
      formatSql("SeLeCt a from t", "mysql", opts({ keywordCase: "preserve" }))
    ).toContain("SeLeCt");
  });

  it("字下げを4つ空け・タブにできる", () => {
    expect(formatSql(SAMPLE, "mysql", opts({ indent: "4" }))).toContain("\n    a");
    expect(formatSql(SAMPLE, "mysql", opts({ indent: "tab" }))).toContain("\n\ta");
  });

  it("AND・OR を行末に置ける", () => {
    const before = formatSql(SAMPLE, "mysql", opts({ logicalNewline: "before" }));
    const after = formatSql(SAMPLE, "mysql", opts({ logicalNewline: "after" }));
    expect(before).toContain("\n  AND b = 2");
    expect(after).toContain("a = 1 AND\n");
  });

  it("キーワードの幅をそろえる字下げにできる", () => {
    const left = formatSql(SAMPLE, "mysql", opts({ indentStyle: "tabularLeft" }));
    // 「SELECT」と値が同じ行に並ぶ
    expect(left.split("\n")[0]).toMatch(/^SELECT\s+a$/);
    const right = formatSql(SAMPLE, "mysql", opts({ indentStyle: "tabularRight" }));
    expect(right.split("\n")[0]).toMatch(/^\s+SELECT a$/);
  });

  it("ONを次の行に出して、条件を一段下げられる", () => {
    const sql =
      "select * from m_users a inner join m_shop b on a.user_id = b.user_id";
    const same = formatSql(sql, "mysql", opts({ onClause: "same" }));
    expect(same).toContain("INNER JOIN m_shop b ON a.user_id = b.user_id");

    const out = formatSql(sql, "mysql", opts({ onClause: "newline" }));
    expect(out).toContain(
      ["  INNER JOIN m_shop b", "  ON", "    a.user_id = b.user_id"].join("\n")
    );
  });

  it("結合条件の続き (AND) も一緒に一段下げる", () => {
    const out = formatSql(
      "select * from a inner join b on a.id = b.id and a.k = b.k where a.x = 1 and a.y = 2",
      "mysql",
      opts({ onClause: "newline" })
    );
    expect(out).toContain(["  ON", "    a.id = b.id", "    AND a.k = b.k"].join("\n"));
    // WHERE の AND は下げない (結合条件ではないため)
    expect(out).toContain(["WHERE", "  a.x = 1", "  AND a.y = 2"].join("\n"));
  });

  it("USING の JOIN はそのまま (ONが無いため)", () => {
    const out = formatSql(
      "select * from a join b using (id)",
      "mysql",
      opts({ onClause: "newline" })
    );
    expect(out).toContain("JOIN b USING (id)");
  });

  it("字下げの設定に合わせて条件を下げる", () => {
    const sql = "select * from a join b on a.id = b.id";
    expect(formatSql(sql, "mysql", opts({ onClause: "newline", indent: "4" })))
      .toContain(["    ON", "        a.id = b.id"].join("\n"));
    expect(formatSql(sql, "mysql", opts({ onClause: "newline", indent: "tab" })))
      .toContain(["\tON", "\t\ta.id = b.id"].join("\n"));
  });

  it("知らない値が入っていても既定で整形する", () => {
    const broken = {
      commaStyle: "sideways",
      keywordCase: "shout",
      indent: "9",
      logicalNewline: "middle",
      indentStyle: "diagonal",
      onClause: "sideways",
    } as unknown as SqlFormatSettings;
    expect(formatSql(SAMPLE, "mysql", broken)).toBe(formatSql(SAMPLE, "mysql"));
  });
});

describe("toLeadingCommas", () => {
  it("行末のカンマを次の行の先頭へ移す", () => {
    expect(toLeadingCommas("  a,\n  b,\n  c")).toBe("  a\n  , b\n  , c");
  });

  it("空行はまたいで移す", () => {
    expect(toLeadingCommas("  a,\n\n  b")).toBe("  a\n\n  , b");
  });

  it("次の行が無ければそのまま", () => {
    expect(toLeadingCommas("  a,")).toBe("  a,");
  });
});
