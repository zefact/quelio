import { describe, expect, it } from "vitest";
import { buildMigration } from "./schemaAlter";
import type { ColumnInfo, IndexInfo, SchemaEntry, TableInfo } from "./types";

const table = (name: string, schema?: string, type = "BASE TABLE"): TableInfo => ({
  name,
  schema,
  tableType: type,
});

const col = (over: Partial<ColumnInfo> & { name: string }): ColumnInfo => ({
  colType: "int",
  nullable: true,
  ...over,
});

const idx = (over: Partial<IndexInfo> & { name: string }): IndexInfo => ({
  unique: false,
  columns: "id",
  constrained: false,
  ...over,
});

const entry = (
  t: TableInfo,
  columns: ColumnInfo[],
  indexes: IndexInfo[] = []
): SchemaEntry => ({
  table: t,
  detail: { columns, indexes, foreignKeys: [], info: [] },
});

describe("buildMigration", () => {
  it("差分が無ければそう言う", () => {
    const e = [entry(table("t"), [col({ name: "id" })])];
    expect(buildMigration("mysql", e, e)).toContain("差分はありません");
  });

  it("右にだけある表はCREATE、左にだけある表はコメントのDROP", () => {
    const left = [entry(table("a"), [col({ name: "id" })])];
    const right = [entry(table("b"), [col({ name: "id" })])];
    const sql = buildMigration("mysql", left, right);
    expect(sql).toContain("CREATE TABLE `b`");
    // 消す操作はそのままでは流れない
    expect(sql).toContain("-- DROP TABLE `a`;");
    expect(sql).not.toMatch(/^DROP TABLE/m);
  });

  it("ビューには DROP VIEW を出す", () => {
    const left = [entry(table("v", undefined, "VIEW"), [col({ name: "id" })])];
    expect(buildMigration("mysql", left, [])).toContain("-- DROP VIEW `v`;");
  });

  it("カラムの追加はADD、削除はコメントのDROP", () => {
    const left = [entry(table("t"), [col({ name: "id" }), col({ name: "old" })])];
    const right = [
      entry(table("t"), [col({ name: "id" }), col({ name: "new" })]),
    ];
    const sql = buildMigration("mysql", left, right);
    expect(sql).toContain("ALTER TABLE `t` ADD COLUMN `new` int NULL;");
    expect(sql).toContain("-- ALTER TABLE `t` DROP COLUMN `old`;");
  });

  it("MySQLの文字列デフォルトは引用符で囲む", () => {
    const left = [entry(table("t"), [col({ name: "s", colType: "varchar(8)" })])];
    const right = [
      entry(table("t"), [
        col({ name: "s", colType: "varchar(8)", default: "active" }),
      ]),
    ];
    expect(buildMigration("mysql", left, right)).toContain(
      "DEFAULT 'active'"
    );
  });

  it("MySQLの式デフォルトは括弧を付け直す", () => {
    const left = [entry(table("t"), [col({ name: "u", colType: "char(36)" })])];
    const right = [
      entry(table("t"), [
        col({
          name: "u",
          colType: "char(36)",
          default: "uuid()",
          extra: "DEFAULT_GENERATED",
        }),
      ]),
    ];
    expect(buildMigration("mysql", left, right)).toContain("DEFAULT (uuid())");
  });

  it("CURRENT_TIMESTAMP と数値はそのまま", () => {
    const left = [entry(table("t"), [col({ name: "a", colType: "timestamp" })])];
    const right = [
      entry(table("t"), [
        col({
          name: "a",
          colType: "timestamp",
          default: "CURRENT_TIMESTAMP",
          extra: "DEFAULT_GENERATED",
        }),
      ]),
    ];
    const sql = buildMigration("mysql", left, right);
    expect(sql).toContain("DEFAULT CURRENT_TIMESTAMP");
    expect(sql).not.toContain("DEFAULT (CURRENT_TIMESTAMP)");
  });

  it("MariaDBのように引用済みで返る値は二重に囲まない", () => {
    const left = [entry(table("t"), [col({ name: "s", colType: "varchar(8)" })])];
    const right = [
      entry(table("t"), [
        col({ name: "s", colType: "varchar(8)", default: "'active'" }),
      ]),
    ];
    const sql = buildMigration("mysql", left, right);
    expect(sql).toContain("DEFAULT 'active'");
    expect(sql).not.toContain("'''active'''");
  });

  it("MySQLのAUTO_INCREMENTを落とさない", () => {
    const left = [
      entry(table("t"), [col({ name: "id", extra: "auto_increment" })]),
    ];
    const right = [
      entry(table("t"), [
        col({ name: "id", nullable: false, extra: "auto_increment" }),
      ]),
    ];
    expect(buildMigration("mysql", left, right)).toContain("AUTO_INCREMENT");
  });

  it("PostgreSQLは変更点ごとに文を分ける", () => {
    const left = [entry(table("t", "public"), [col({ name: "a" })])];
    const right = [
      entry(table("t", "public"), [
        col({ name: "a", colType: "bigint", nullable: false }),
      ]),
    ];
    const sql = buildMigration("postgresql", left, right);
    expect(sql).toContain('ALTER COLUMN "a" TYPE bigint;');
    expect(sql).toContain('ALTER COLUMN "a" SET NOT NULL;');
    expect(sql).toContain('ALTER COLUMN "a" DROP DEFAULT;');
  });

  it("SQLiteはカラムを変えられないと伝える", () => {
    const left = [entry(table("t"), [col({ name: "a" })])];
    const right = [entry(table("t"), [col({ name: "a", colType: "text" })])];
    const sql = buildMigration("sqlite", left, right);
    expect(sql).toContain("SQLiteはカラムの型");
    expect(sql).not.toContain("ALTER COLUMN");
  });

  it("インデックスの追加はCREATE、削除はコメント", () => {
    const left = [entry(table("t"), [col({ name: "id" })], [])];
    const right = [
      entry(table("t"), [col({ name: "id" })], [idx({ name: "ix", unique: true })]),
    ];
    expect(buildMigration("mysql", left, right)).toContain(
      "CREATE UNIQUE INDEX `ix` ON `t` (`id`);"
    );
    expect(buildMigration("mysql", right, left)).toContain(
      "-- ALTER TABLE `t` DROP INDEX `ix`;"
    );
  });

  it("接頭辞インデックスは長さも書く", () => {
    const left = [entry(table("t"), [col({ name: "body" })], [])];
    const right = [
      entry(
        table("t"),
        [col({ name: "body" })],
        [idx({ name: "ix", columns: "body", subParts: [10] })]
      ),
    ];
    expect(buildMigration("mysql", left, right)).toContain(
      "CREATE INDEX `ix` ON `t` (`body`(10));"
    );
  });

  it("式インデックスは組み立てずコメントにする", () => {
    const left = [entry(table("t"), [col({ name: "a" })], [])];
    const right = [
      entry(
        table("t"),
        [col({ name: "a" })],
        [idx({ name: "ix", columns: "(lower(a))" })]
      ),
    ];
    const sql = buildMigration("mysql", left, right);
    expect(sql).toContain("式や条件を含むため");
    expect(sql).not.toContain("CREATE INDEX `ix`");
  });

  it("DB種別が違うときは注意書きを出す", () => {
    const e = [entry(table("t"), [col({ name: "id" })])];
    expect(buildMigration("mysql", e, e, "postgresql")).toContain(
      "DBの種類が違います"
    );
    expect(buildMigration("mysql", e, e, "mysql")).not.toContain(
      "DBの種類が違います"
    );
  });

  it("バックスラッシュを含むデフォルトでも文字列が閉じる", () => {
    const left = [entry(table("t"), [col({ name: "p", colType: "varchar(20)" })])];
    const right = [
      entry(table("t"), [
        col({ name: "p", colType: "varchar(20)", default: "C:\\tmp\\" }),
      ]),
    ];
    const sql = buildMigration("mysql", left, right);
    expect(sql).toContain("DEFAULT 'C:\\\\tmp\\\\'");
  });
});

describe("PostgreSQL の再現", () => {
  /*
   * ここで使う値は、実際の PostgreSQL 16 に問い合わせて確かめたもの:
   *   pg_get_partkeydef → "RANGE (at)"
   *   pg_get_expr(relpartbound, oid) → "FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')"
   */

  it("連番列は serial に戻す", () => {
    /*
     * カタログ上は「integer + DEFAULT nextval('…')」に見える。
     * そのまま出すとシーケンスが無くて作れない
     */
    const right = [
      entry(table("t", "public"), [
        col({
          name: "id",
          colType: "integer",
          nullable: false,
          default: "nextval('t_id_seq'::regclass)",
        }),
        col({ name: "big", colType: "bigint", default: "nextval('s'::regclass)" }),
        col({ name: "small", colType: "smallint", default: "nextval('s'::regclass)" }),
      ]),
    ];
    const sql = buildMigration("postgresql", [], right);
    expect(sql).toContain('"id" serial');
    expect(sql).toContain('"big" bigserial');
    expect(sql).toContain('"small" smallserial');
    // 型名だけで NOT NULL と既定値まで含むので、重ねて書かない
    expect(sql).not.toContain("nextval");
  });

  it("連番でない既定値はそのまま出す", () => {
    const right = [
      entry(table("t", "public"), [
        col({ name: "n", colType: "integer", default: "0" }),
      ]),
    ];
    expect(buildMigration("postgresql", [], right)).toContain('"n" integer NULL DEFAULT 0');
  });

  it("パーティションの親には分け方を付ける", () => {
    const t = table("sales", "public");
    t.partitionBy = "RANGE (at)";
    const right = [entry(t, [col({ name: "at", colType: "date", nullable: false })])];
    const sql = buildMigration("postgresql", [], right);
    expect(sql).toContain("PARTITION BY RANGE (at);");
  });

  it("パーティションの子は列を並べ直さない", () => {
    const t = table("sales_2024_01", "public");
    t.partitionOf = [
      '"public"."sales"',
      "FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')",
    ];
    const right = [entry(t, [col({ name: "at", colType: "date" })])];
    const sql = buildMigration("postgresql", [], right);
    expect(sql).toContain(
      'CREATE TABLE "public"."sales_2024_01" PARTITION OF "public"."sales"'
    );
    expect(sql).toContain("FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');");
    // 列は親から引き継ぐので書かない
    expect(sql).not.toContain('"at" date');
  });
});
