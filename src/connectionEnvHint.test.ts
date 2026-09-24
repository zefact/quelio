import { describe, expect, it } from "vitest";
import { envFieldNote, envListLabel, prodWritable } from "./connectionEnvHint";

describe("prodWritable", () => {
  it("本番で読み取り専用が外れているときだけ促す", () => {
    expect(prodWritable("prod", false)).toBe(true);
    expect(prodWritable("prod", undefined)).toBe(true);
  });

  it("読み取り専用なら促さない", () => {
    expect(prodWritable("prod", true)).toBe(false);
  });

  it("本番以外・未設定では促さない", () => {
    expect(prodWritable("staging", false)).toBe(false);
    expect(prodWritable("dev", false)).toBe(false);
    expect(prodWritable(undefined, false)).toBe(false);
  });
});

describe("envFieldNote", () => {
  it("本番では何が効くのかを書く", () => {
    expect(envFieldNote("prod")).toContain("更新のたびに確認");
  });

  it("本番以外・未設定では設定を促す", () => {
    expect(envFieldNote(undefined)).toContain("本番は必ず設定してください");
    expect(envFieldNote("dev")).toContain("本番は必ず設定してください");
  });
});

describe("envListLabel", () => {
  it("未設定のときだけラベルを出す", () => {
    expect(envListLabel(undefined)).toBe("環境未設定");
    expect(envListLabel("prod")).toBe("");
  });
});
