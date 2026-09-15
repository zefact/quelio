import { describe, expect, it } from "vitest";
import {
  exportName,
  exportNames,
  headerText,
  headerWidth,
} from "./headerLabel";

describe("headerText", () => {
  it("英語名だけ出す", () => {
    expect(headerText("user_id", "利用者ID", "name")).toEqual({
      main: "user_id",
      mainJa: false,
    });
  });

  it("日本語名だけ出す", () => {
    expect(headerText("user_id", "利用者ID", "logical")).toEqual({
      main: "利用者ID",
      mainJa: true,
    });
  });

  it("両方なら英語名を1段目、日本語名を2段目に出す", () => {
    expect(headerText("user_id", "利用者ID", "both")).toEqual({
      main: "user_id",
      sub: "利用者ID",
      mainJa: false,
    });
  });

  it("日本語名が無ければ、どの設定でも英語名を出す", () => {
    for (const mode of ["name", "logical", "both"] as const) {
      expect(headerText("cnt", undefined, mode), mode).toEqual({
        main: "cnt",
        mainJa: false,
      });
      expect(headerText("cnt", "", mode), mode).toEqual({
        main: "cnt",
        mainJa: false,
      });
    }
  });

  it("空白だけの日本語名は無いものとして扱う", () => {
    expect(headerText("cnt", "   ", "logical")).toEqual({
      main: "cnt",
      mainJa: false,
    });
  });

  it("日本語名の前後の空白は落とす", () => {
    expect(headerText("cnt", " 件数 ", "logical").main).toBe("件数");
  });
});

describe("headerWidth", () => {
  it("短い名前でも下限までは広げる", () => {
    expect(headerWidth("id")).toBe(90);
  });

  it("長い名前でも上限で止まる", () => {
    expect(headerWidth("a".repeat(100))).toBe(260);
  });

  it("全角は半角より広く見積もる", () => {
    expect(headerWidth("あいうえおかきくけこ")).toBeGreaterThan(
      headerWidth("abcdefghij")
    );
  });

  it("2段のときは広いほうに合わせる", () => {
    const narrow = headerWidth("id");
    const wide = headerWidth("id", "利用者の識別番号");
    expect(wide).toBeGreaterThan(narrow);
    expect(wide).toBe(headerWidth("利用者の識別番号"));
  });

  it("2段目が無くても1段目だけで決まる", () => {
    expect(headerWidth("created_at", undefined)).toBe(headerWidth("created_at"));
  });
});

describe("exportName", () => {
  it("日本語名を選んでいるときだけ日本語名にする", () => {
    expect(exportName("user_id", "利用者ID", "logical")).toBe("利用者ID");
    expect(exportName("user_id", "利用者ID", "name")).toBe("user_id");
    // 両方のときは画面に英語名も出ているので、英語名のまま
    expect(exportName("user_id", "利用者ID", "both")).toBe("user_id");
  });

  it("日本語名が無ければ英語名のまま", () => {
    expect(exportName("cnt", undefined, "logical")).toBe("cnt");
  });
});

describe("exportNames", () => {
  const labels = { user_id: "利用者ID", cnt: "件数" };

  it("日本語名を選んでいれば置き換えた並びを返す", () => {
    expect(exportNames(["user_id", "cnt", "memo"], labels, "logical")).toEqual([
      "利用者ID",
      "件数",
      "memo",
    ]);
  });

  it("英語名・両方のときは指定しない", () => {
    expect(exportNames(["user_id"], labels, "name")).toBeUndefined();
    expect(exportNames(["user_id"], labels, "both")).toBeUndefined();
  });

  it("置き換えるところが無ければ指定しない", () => {
    expect(exportNames(["memo", "note"], labels, "logical")).toBeUndefined();
  });

  it("大文字小文字が違っても引ける", () => {
    expect(exportNames(["USER_ID"], labels, "logical")).toEqual(["利用者ID"]);
  });
});
