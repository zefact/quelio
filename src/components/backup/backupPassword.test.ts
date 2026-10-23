import { describe, expect, it } from "vitest";
import { backupPasswordProblem } from "./backupPassword";

describe("バックアップのパスワード", () => {
  it("8文字未満は断る", () => {
    expect(backupPasswordProblem("1234567", "1234567")).toContain("8文字以上");
  });

  it("確認と一致しなければ断る", () => {
    expect(backupPasswordProblem("12345678", "1234567x")).toContain("一致しません");
  });

  it("8文字以上で一致すればよい", () => {
    expect(backupPasswordProblem("12345678", "12345678")).toBeNull();
    // 文字数は日本語も1文字と数える
    expect(backupPasswordProblem("あいうえおかきく", "あいうえおかきく")).toBeNull();
  });
});
