import { describe, expect, it } from "vitest";
import { createImeTracker, IME_GRACE_MS } from "./ime";

describe("日本語入力の判定", () => {
  it("変換中のキーは操作として扱わない", () => {
    const t = 0;
    const ime = createImeTracker(() => t);
    expect(ime.busy({ key: "Enter" })).toBe(false);
    ime.start();
    expect(ime.busy({ key: "Enter" })).toBe(true);
    expect(ime.busy({ key: "a", isComposing: true })).toBe(true);
    expect(ime.busy({ key: "Enter", keyCode: 229 })).toBe(true);
  });

  it("Macでは確定のEnterが変換の終わりの後に届くので、直後のEnter・Escも拾わない", () => {
    let t = 1000;
    const ime = createImeTracker(() => t);
    ime.start();
    ime.end();
    t += 10;
    expect(ime.busy({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(true);
    expect(ime.busy({ key: "Escape" })).toBe(true);
    // 他のキーは止めない
    expect(ime.busy({ key: "ArrowDown" })).toBe(false);
    // 少し経ってから押したEnterは、決定として扱う
    t += IME_GRACE_MS;
    expect(ime.busy({ key: "Enter", keyCode: 13 })).toBe(false);
  });
});
