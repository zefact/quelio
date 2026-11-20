import { describe, expect, it } from "vitest";
import {
  columnChangeWhat,
  confirmHeading,
  csvImportText,
  dbAdminText,
  dbUserChangeText,
  foreignKeyChangeWhat,
  indexChangeWhat,
  kvChangeWhat,
  needsStructureConfirm,
  prodActionText,
  tableNameWhat,
  rowChangeText,
  sqlFileText,
  tableRenameWhat,
  testDataText,
} from "./prodConfirm";
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

describe("sqlFileText", () => {
  it("どのデータベースでどのファイルを流すかを書く", () => {
    expect(sqlFileText("shop", "dump.sql")).toBe(
      "本番環境の shop で、SQLファイル dump.sql を実行します。"
    );
  });
});

describe("testDataText", () => {
  it("どのテーブルへ何行入れるかを書く", () => {
    expect(testDataText("public.users", 10000)).toBe(
      "本番環境の public.users へ、テストデータを 10,000 行入れます。"
    );
  });
});

describe("dbUserChangeText", () => {
  it("見出しをそのまま文にする (句点は1つだけ)", () => {
    expect(dbUserChangeText("'alice'@'%'", "権限を付けます")).toBe(
      "本番環境の 'alice'@'%' について、権限を付けます。"
    );
    expect(dbUserChangeText("bob", "ロールを削除します。")).toBe(
      "本番環境の bob について、ロールを削除します。"
    );
  });
});

describe("dbAdminText", () => {
  it("作成・削除・所有者の変更をそれぞれ1行で書く", () => {
    expect(dbAdminText({ kind: "create", what: "データベース", name: "app" })).toBe(
      "本番環境にデータベース app を作成します。"
    );
    expect(dbAdminText({ kind: "drop", what: "スキーマ", name: "old" })).toBe(
      "本番環境のスキーマ old を削除します。"
    );
    expect(dbAdminText({ kind: "owner", name: "app", owner: "admin" })).toBe(
      "本番環境のデータベース app の所有者を admin に変更します。"
    );
  });
});

describe("prodActionText", () => {
  it("どこで何をするかを決まった形で書く", () => {
    expect(prodActionText("users", "カラム a を追加します")).toBe(
      "本番環境の users で、カラム a を追加します。"
    );
  });
});

describe("needsStructureConfirm", () => {
  it("本番は設定に関わらず確認する", () => {
    expect(needsStructureConfirm(true, false)).toBe(true);
    expect(needsStructureConfirm(true, true)).toBe(true);
  });

  it("本番以外は「定義の変更も確認する」に従う", () => {
    expect(needsStructureConfirm(false, true)).toBe(true);
    expect(needsStructureConfirm(false, false)).toBe(false);
  });
});

describe("構造の変更の説明", () => {
  const spec = { name: "age", colType: "int", nullable: true };

  it("カラムの追加・削除・変更・名前の変更を書き分ける", () => {
    expect(columnChangeWhat({ kind: "add", column: spec })).toBe(
      "カラム age を追加します"
    );
    expect(columnChangeWhat({ kind: "drop", name: "age" })).toBe(
      "カラム age を削除します"
    );
    expect(
      columnChangeWhat({ kind: "modify", before: spec, column: spec })
    ).toBe("カラム age の定義を変更します");
    expect(
      columnChangeWhat({
        kind: "modify",
        before: spec,
        column: { ...spec, name: "years" },
      })
    ).toBe("カラム age を years に変更します");
    expect(
      columnChangeWhat({
        kind: "modify",
        before: spec,
        column: { ...spec, after: "FIRST" },
      })
    ).toBe("カラム age の位置を変えます");
  });

  it("インデックス", () => {
    const index = { name: "ix_a", unique: false, columns: ["a"] };
    expect(indexChangeWhat({ kind: "add", index })).toBe(
      "インデックス ix_a を作成します"
    );
    expect(indexChangeWhat({ kind: "drop", name: "ix_a" })).toBe(
      "インデックス ix_a を削除します"
    );
    expect(indexChangeWhat({ kind: "modify", before: "ix_a", index })).toBe(
      "インデックス ix_a を作り直します"
    );
  });

  it("外部キーは名前が空ならDBに任せる書き方にする", () => {
    const fk = {
      name: "",
      columns: ["user_id"],
      refTable: "users",
      refColumns: ["id"],
    };
    expect(foreignKeyChangeWhat({ kind: "add", fk })).toBe("外部キーを追加します");
    expect(
      foreignKeyChangeWhat({ kind: "add", fk: { ...fk, name: "fk_u" } })
    ).toBe("外部キー fk_u を追加します");
    expect(foreignKeyChangeWhat({ kind: "drop", name: "fk_u" })).toBe(
      "外部キー fk_u を削除します"
    );
  });

  it("日本語名は空にするときを書き分ける", () => {
    expect(tableNameWhat("利用者")).toBe("日本語名を「利用者」にします");
    expect(tableNameWhat("")).toBe("日本語名を消します");
  });
});

describe("kvChangeWhat", () => {
  it("キーへの操作を1行で書く", () => {
    expect(kvChangeWhat({ kind: "rename", key: "a", newKey: "b" })).toBe(
      "キー a の名前を b に変えます"
    );
    expect(kvChangeWhat({ kind: "expire", key: "a", ttl: 0 })).toBe(
      "キー a を無期限にします"
    );
    expect(kvChangeWhat({ kind: "expire", key: "a", ttl: 60 })).toBe(
      "キー a の TTL を 60 秒にします"
    );
    const row = { field: "f", value: "v" };
    expect(
      kvChangeWhat({ kind: "createKey", key: "a", kvType: "hash", row })
    ).toBe("キー a を作成します");
    expect(kvChangeWhat({ kind: "remove", key: "a", kvType: "set", row })).toBe(
      "キー a の要素を1件削除します"
    );
  });
});

describe("tableRenameWhat", () => {
  it("変更前と変更後の名前を1行で書く", () => {
    expect(tableRenameWhat("users", "members")).toBe(
      "テーブル名を users から members に変更します"
    );
  });
});
