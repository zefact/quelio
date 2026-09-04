import { describe, expect, it } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import type { CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { keepOrder, orderBoost, sqlCompletion } from "./sqlCompletion";
import type { SchemaMap } from "./sqlCompletion";

describe("orderBoost", () => {
  it("先に定義されたものほど大きい", () => {
    const boosts = [0, 1, 2, 3].map((at) => orderBoost(at, 4));
    expect(boosts).toEqual([...boosts].sort((a, b) => b - a));
    expect(new Set(boosts).size).toBe(4);
  });

  it("絞り込みの一致度 (100点刻み) を追い越さない幅に収まる", () => {
    // 端どうしの差が200以上あると、一致度の低い候補が上に来てしまう
    for (const total of [1, 2, 50, 500]) {
      for (const at of [0, total - 1]) {
        expect(Math.abs(orderBoost(at, total))).toBeLessThanOrEqual(99);
      }
    }
  });

  it("カラムが多くても順番が入れ替わらない", () => {
    const boosts = Array.from({ length: 500 }, (_, at) => orderBoost(at, 500));
    for (let at = 1; at < boosts.length; at++) {
      expect(boosts[at]).toBeLessThan(boosts[at - 1]);
    }
  });
});

describe("keepOrder", () => {
  it("並べた順のまま重みを付ける", () => {
    const out = keepOrder([{ label: "id" }, { label: "created_at" }]);
    expect(out.map((o) => o.label)).toEqual(["id", "created_at"]);
    expect(out[0].boost).toBeGreaterThan(out[1].boost!);
  });

  it("元の候補は書き換えない", () => {
    const src = [{ label: "id" }, { label: "name" }];
    keepOrder(src);
    expect(src[0]).not.toHaveProperty("boost");
  });
});

/** テスト用のスキーマ (日本語名と型は空でよい) */
const SCHEMA: SchemaMap = {
  users: {
    logical: "利用者",
    columns: [
      { name: "id", logical: "", dataType: "int", pk: true },
      { name: "name", logical: "", dataType: "varchar", pk: false },
      { name: "email", logical: "", dataType: "varchar", pk: false },
    ],
  },
  orders: {
    logical: "注文",
    columns: [
      { name: "id", logical: "", dataType: "int", pk: true },
      { name: "user_id", logical: "", dataType: "int", pk: false },
      { name: "total", logical: "", dataType: "int", pk: false },
    ],
  },
};

/** `|` の位置で補完を呼び、候補の名前だけを返す */
function complete(sqlWithCaret: string, explicit = true): string[] {
  const pos = sqlWithCaret.indexOf("|");
  const doc = sqlWithCaret.replace("|", "");
  const state = EditorState.create({ doc });
  // 補完元は同期に候補を返す (この実装ではPromiseにならない)
  const got = sqlCompletion(() => SCHEMA)(
    new CompletionContext(state, pos, explicit)
  ) as CompletionResult | null;
  return got ? got.options.map((o) => o.label) : [];
}

describe("sqlCompletion — 取得元から候補を出す", () => {
  it("FROMの直後はテーブル名", () => {
    expect(complete("select * from |")).toEqual(["users", "orders"]);
  });

  it("別名のあとはそのテーブルのカラム", () => {
    expect(complete("select u.| from users u")).toEqual([
      "id",
      "name",
      "email",
    ]);
  });

  it("別名を付けていなければテーブル名でも引ける", () => {
    expect(complete("select users.| from users")).toEqual([
      "id",
      "name",
      "email",
    ]);
  });

  it("WITH句の名前をテーブル名の候補に出す", () => {
    const got = complete("with recent as (select id from orders) select * from |");
    expect(got[0]).toBe("recent");
  });

  it("WITH句が返す列を出す", () => {
    const sql =
      "with recent as (select id, total from orders) select r.| from recent r";
    expect(complete(sql)).toEqual(["id", "total"]);
  });

  it("導出表が返す列を出す", () => {
    const sql = "select x.| from (select id, name from users) x";
    expect(complete(sql)).toEqual(["id", "name"]);
  });

  it("導出表の * は元のテーブルの列に開く", () => {
    const sql = "select x.| from (select * from users) x";
    expect(complete(sql)).toEqual(["id", "name", "email"]);
  });

  it("副問い合わせの中は内側のテーブルのカラムを出す", () => {
    const sql = "select * from users u where u.id in (select o.| from orders o)";
    expect(complete(sql)).toEqual(["id", "user_id", "total"]);
  });

  it("副問い合わせの中でも外側の別名が使える", () => {
    const sql = "select * from users u where exists (select 1 from orders o where u.| )";
    expect(complete(sql)).toEqual(["id", "name", "email"]);
  });

  it("名前の付いていない式は列にしない", () => {
    const sql = "select x.| from (select id, total * 2 from orders) x";
    expect(complete(sql)).toEqual(["id"]);
  });

  it("見えている取得元が無ければテーブル名を出す", () => {
    expect(complete("select | ")).toEqual(["users", "orders"]);
  });
});
