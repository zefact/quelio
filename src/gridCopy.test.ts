import { describe, expect, it } from "vitest";
import {
  disarmFormula,
  toInsert,
  toJson,
  toMarkdown,
  toTsv,
  tsvCell,
} from "./gridCopy";

describe("disarmFormula", () => {
  it("数式として実行されうる値に印を付ける", () => {
    for (const v of [
      "=1+1",
      "@SUM(A1)",
      "+1+1",
      "-2+3+cmd|' /C calc'!A0",
      "\t=1+1",
      " =1+1",
      "-inf",
    ]) {
      expect(disarmFormula(v)).toBe(`'${v}`);
    }
  });

  it("ただの数値・普通の文字列はそのまま", () => {
    for (const v of ["-1", "+3.5", "-1.2e5", "0", "abc", "", "山田", "a=b"]) {
      expect(disarmFormula(v)).toBe(v);
    }
  });
});

describe("tsvCell", () => {
  it("タブや改行を含む値は囲む (列や行が増えないように)", () => {
    expect(tsvCell("a\tb")).toBe('"a\tb"');
    expect(tsvCell("a\nb")).toBe('"a\nb"');
    // 先頭がタブの値は、印だけ別の列に入ってしまわないよう囲む
    expect(tsvCell("\t=1+1")).toBe('"\'\t=1+1"');
  });

  it("途中の引用符は触らない (テキストへ貼ったときに崩れる)", () => {
    expect(tsvCell('{"a": 1}')).toBe('{"a": 1}');
    expect(tsvCell('He said "hi"')).toBe('He said "hi"');
  });

  it("先頭が引用符なら囲んで重ねる", () => {
    expect(tsvCell('"x"')).toBe('"""x"""');
  });
});

describe("toTsv", () => {
  it("NULLは空欄、ヘッダーは任意", () => {
    const data = [
      ["1", null],
      ["2", "x"],
    ];
    expect(toTsv(data)).toBe("1\t\n2\tx");
    expect(toTsv(data, ["id", "name"])).toBe("id\tname\n1\t\n2\tx");
  });
});

describe("toJson", () => {
  it("NULLはnullのまま", () => {
    expect(JSON.parse(toJson([["1", null]], ["id", "name"]))).toEqual([
      { id: "1", name: null },
    ]);
  });

  it("同じ名前の列は番号を付けて潰さない", () => {
    const out = JSON.parse(toJson([["1", "2"]], ["a", "a"]));
    expect(out).toEqual([{ a: "1", a_2: "2" }]);
  });
});

describe("toMarkdown", () => {
  it("表として読める形にする", () => {
    expect(toMarkdown([["1", null]], ["id", "name"])).toBe(
      "| id | name |\n| --- | --- |\n| 1 |  |"
    );
  });

  it("改行とパイプで表が崩れない", () => {
    expect(toMarkdown([["a|b"]], ["c"])).toContain("a\\|b");
    expect(toMarkdown([["a\nb"]], ["c"])).toContain("a<br>b");
  });
});

describe("toInsert", () => {
  it("NULLはNULL、他は文字列リテラルにする", () => {
    expect(toInsert([["1", null]], "`t`", ["`a`", "`b`"])).toBe(
      "INSERT INTO `t` (`a`, `b`) VALUES ('1', NULL);"
    );
  });

  it("引用符を重ねて文字列を閉じられないようにする", () => {
    expect(toInsert([["a'b"]], "`t`", ["`a`"])).toContain("'a''b'");
  });

  it("MySQLではバックスラッシュも重ねる", () => {
    expect(toInsert([["C:\\tmp\\"]], "`t`", ["`a`"], "mysql")).toContain(
      "'C:\\\\tmp\\\\'"
    );
    // PostgreSQLは既定でバックスラッシュをエスケープ扱いしない
    expect(toInsert([["C:\\tmp"]], '"t"', ['"a"'], "postgresql")).toContain(
      "'C:\\tmp'"
    );
  });

  it("行ごとに1文ずつ出す", () => {
    expect(toInsert([["1"], ["2"]], "`t`", ["`a`"]).split("\n")).toHaveLength(2);
  });
});
