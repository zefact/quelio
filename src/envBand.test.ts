import { describe, expect, it } from "vitest";
import { envBandText, tabEnvMark } from "./envBand";

describe("tabEnvMark", () => {
  it("本番の接続タブには印を付ける", () => {
    expect(tabEnvMark("prod", true)).toEqual({ label: "本番", env: "prod" });
  });

  it("本番以外と未設定には付けない (本番だけを目立たせる)", () => {
    expect(tabEnvMark("staging", true)).toBeNull();
    expect(tabEnvMark("dev", true)).toBeNull();
    expect(tabEnvMark(undefined, true)).toBeNull();
  });

  it("未接続のタブには付けない", () => {
    expect(tabEnvMark("prod", false)).toBeNull();
  });
});

describe("envBandText", () => {
  it("本番は「本番環境 — 接続名」", () => {
    expect(envBandText("prod", "社内MySQL")).toEqual({
      text: "本番環境 — 社内MySQL",
      env: "prod",
    });
  });

  it("ステージングも出すが、字面を分ける", () => {
    expect(envBandText("staging", "stg")).toEqual({
      text: "ステージング — stg",
      env: "staging",
    });
  });

  it("開発・未設定では帯を出さない", () => {
    expect(envBandText("dev", "local")).toBeNull();
    expect(envBandText(undefined, "local")).toBeNull();
  });

  it("接続名が空でも読める", () => {
    expect(envBandText("prod", "  ")?.text).toBe("本番環境 — (無名)");
  });
});
