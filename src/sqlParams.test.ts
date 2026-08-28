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
