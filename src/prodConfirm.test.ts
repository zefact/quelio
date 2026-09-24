import { describe, expect, it } from "vitest";
import { confirmHeading, csvImportText, rowChangeText } from "./prodConfirm";
import type { DangerousStatement } from "./types/query";

const stmt = (over: Partial<DangerousStatement>): DangerousStatement => ({
  definitionChange: false,
  kind: "DROP (テーブルやデータベースごと削除)",
  sql: "DROP TABLE t",
  ...over,
});

describe("confirmHeading", () => {
  it("本番の更新が混ざっていれば、それを見出しにする", () => {
    const got = confirmHeading([
      stmt({ kind: "UPDATE (本番環境への更新)", prodUpdate: true }),
    ]);
    expect(got).toEqual({ title: "本番環境で更新を実行します", prod: true });
  });

  it("本番以外は今までどおりの見出し", () => {
    expect(confirmHeading([stmt({})])).toEqual({
      title: "このSQLを実行しますか",
      prod: false,
    });
  });

  it("危険なSQLと本番の更新が混ざっていれば本番を前に出す", () => {
    const got = confirmHeading([
      stmt({ prodUpdate: true }),
      stmt({ kind: "TRUNCATE (全行削除)", prodUpdate: true }),
    ]);
    expect(got.prod).toBe(true);
  });
});

describe("rowChangeText", () => {
  it("何をするのかを1行で書く", () => {
    expect(rowChangeText("update", "users")).toBe(
      "本番環境の users で、1行の内容を書き換えます。"
    );
    expect(rowChangeText("insert", "users")).toContain("1行を追加します");
    expect(rowChangeText("delete", "users")).toContain("1行を削除します");
  });
});

describe("csvImportText", () => {
  it("どのテーブルへ何行入るかを書く", () => {
    expect(csvImportText("public.logs", 12345)).toBe(
      "本番環境の public.logs へ 12,345 行取り込みます。"
    );
  });

  it("下見を打ち切ったときは実際より少なく見せない", () => {
    expect(csvImportText("logs", 100000, true)).toBe(
      "本番環境の logs へ 100,000 行以上取り込みます。"
    );
  });
});
