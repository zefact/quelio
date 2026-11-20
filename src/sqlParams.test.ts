import { describe, expect, it } from "vitest";
import {
  extractParams,
  guessParamColumn,
  isNumericType,
} from "./sqlParams";

describe("extractParams", () => {
  it("同じ名前は1回だけ、出てきた順に返す", () => {
    expect(
      extractParams("SELECT * FROM t WHERE a = :b AND c = @a AND d = :b")
    ).toEqual(["b", "a"]);
  });

  it("文字列リテラルの中は拾わない", () => {
    expect(extractParams("SELECT ':a', \":b\", `:c` FROM t")).toEqual([]);
    // '' と \' のエスケープをまたいでも閉じ位置を見失わない
    expect(extractParams("SELECT 'it''s :a', :real FROM t")).toEqual(["real"]);
    expect(extractParams("SELECT 'x\\':a', :real FROM t")).toEqual(["real"]);
  });

  it("コメントの中は拾わない", () => {
    expect(extractParams("-- :a\nSELECT :b")).toEqual(["b"]);
    expect(extractParams("# :a\nSELECT :b")).toEqual(["b"]);
    expect(extractParams("/* :a */ SELECT :b")).toEqual(["b"]);
    // 閉じていないブロックコメントは末尾まで飲み込む
    expect(extractParams("SELECT :b /* :a")).toEqual(["b"]);
  });

  it("PostgreSQLのキャストとシステム変数は無視する", () => {
    expect(extractParams("SELECT x::text FROM t")).toEqual([]);
    expect(extractParams("SELECT @@version")).toEqual([]);
    // キャストの直後に本物のパラメータが来ても拾える
    expect(extractParams("SELECT x::text WHERE y = :v")).toEqual(["v"]);
  });

  it("日本語の名前も使える", () => {
    expect(extractParams("SELECT * FROM t WHERE 名前 = :名前")).toEqual([
      "名前",
    ]);
  });

  it("名前が続かない : や @ は拾わない", () => {
    expect(extractParams("SELECT 1 : 2")).toEqual([]);
    expect(extractParams("SELECT 'a@' FROM t")).toEqual([]);
  });
});

describe("extractParams の接続先ごとの読み方", () => {
  it("PostgreSQL では $タグ$ … $タグ$ の中を拾わない", () => {
    const sql =
      "UPDATE t SET v = replace(v, $q$判別しにくい場合は書く。$q$, " +
      "$q$書く（例:「通路の右側に段ボールが2箱」）。$q$) WHERE k = :k";
    expect(extractParams(sql, "postgresql")).toEqual(["k"]);
    expect(extractParams("SELECT $$ :a $$, :b", "postgresql")).toEqual(["b"]);
    // 閉じていないドル引用符は末尾まで文字列
    expect(extractParams("SELECT :b, $x$ :a", "postgresql")).toEqual(["b"]);
  });

  it("$1 や a$b$ はドル引用符ではない", () => {
    expect(extractParams("SELECT $1, :a, $2", "postgresql")).toEqual(["a"]);
    expect(extractParams("SELECT a$b$ :c", "postgresql")).toEqual(["c"]);
  });

  it("MySQL では $ は引用符ではなく、# はコメント", () => {
    expect(extractParams("SELECT '$q$', :a # :b", "mysql")).toEqual(["a"]);
  });

  it("PostgreSQL では # はコメントではなく、\\ は文字列を逃がさない", () => {
    expect(extractParams("SELECT 1 # :a", "postgresql")).toEqual(["a"]);
    expect(extractParams("SELECT 'C:\\', :a", "postgresql")).toEqual(["a"]);
  });

  it("MySQL の -- は直後に空白が要る (1--2 は引き算)", () => {
    expect(extractParams("SELECT 1--:a", "mysql")).toEqual(["a"]);
    expect(extractParams("SELECT 1 -- :a", "mysql")).toEqual([]);
  });

  it("「 や 、 などの記号は名前に含めない", () => {
    expect(extractParams("SELECT :名前、:a")).toEqual(["名前", "a"]);
    expect(extractParams("SELECT '例:「通路」'")).toEqual([]);
    expect(extractParams("SELECT 1 WHERE x = 例:「通路」")).toEqual([]);
    // サロゲートペアの字も名前に使える
    expect(extractParams("SELECT :𠮷野")).toEqual(["𠮷野"]);
  });
});

describe("guessParamColumn", () => {
  it("比較の相手のカラム名を返す (前後どちらでも)", () => {
    expect(guessParamColumn("WHERE u.code = :code", "code")).toBe("code");
    expect(guessParamColumn("WHERE :d <= created_at", "d")).toBe("created_at");
    expect(guessParamColumn("WHERE name LIKE :q", "q")).toBe("name");
  });

  it("見つからなければnull", () => {
    expect(guessParamColumn("SELECT :a", "a")).toBeNull();
  });
});

describe("isNumericType", () => {
  it("数値型を見分ける", () => {
    for (const t of ["int", "BIGINT", "decimal(10,2)", "double", "serial"]) {
      expect(isNumericType(t)).toBe(true);
    }
    for (const t of ["varchar(10)", "text", "date", "json"]) {
      expect(isNumericType(t)).toBe(false);
    }
  });
});
