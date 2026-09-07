import { describe, expect, it } from "vitest";
import { shouldAsk } from "./memoryPoll";

/** 全部そろって数えに行ける状態 */
const ready = { enabled: true, hidden: false, asking: false };

describe("shouldAsk", () => {
  it("ONで表に出ていて手が空いていれば数えに行く", () => {
    expect(shouldAsk(ready)).toBe(true);
  });

  it("設定がOFFなら数えに行かない", () => {
    expect(shouldAsk({ ...ready, enabled: false })).toBe(false);
  });

  it("窓が裏に回っていれば数えに行かない", () => {
    expect(shouldAsk({ ...ready, hidden: true })).toBe(false);
  });

  it("前の問い合わせが返っていなければ重ねて投げない", () => {
    expect(shouldAsk({ ...ready, asking: true })).toBe(false);
  });

  it("OFFなら表に出ていても数えに行かない", () => {
    expect(shouldAsk({ enabled: false, hidden: false, asking: false })).toBe(
      false,
    );
  });
});
