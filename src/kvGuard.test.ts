import { describe, expect, it } from "vitest";
import { afterKvCheck, KV_CHECK_FAILED } from "./kvGuard";

describe("afterKvCheck", () => {
  it("確認が要るコマンドがあれば確認を出す", () => {
    expect(afterKvCheck(["FLUSHALL"], false)).toEqual({
      kind: "confirm",
      commands: ["FLUSHALL"],
    });
  });

  it("無ければそのまま実行する", () => {
    expect(afterKvCheck([], true)).toEqual({ kind: "run" });
  });

  it("判定できなかったとき、本番以外では止めない", () => {
    expect(afterKvCheck(null, false)).toEqual({ kind: "run" });
  });

  /* SQLエディタ側と同じ扱い (本番だけ確認する側に倒す) */
  it("判定できなかったとき、本番では確認を出す", () => {
    expect(afterKvCheck(null, true)).toEqual({
      kind: "confirm",
      commands: [KV_CHECK_FAILED],
    });
  });
});
