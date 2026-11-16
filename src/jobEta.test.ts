import { describe, expect, it } from "vitest";
import {
  fmtDuration,
  fmtRemaining,
  pushSample,
  remainingSeconds,
  type EtaSample,
} from "./jobEta";

describe("remainingSeconds", () => {
  it("始めのうちは見積もらない", () => {
    expect(remainingSeconds([])).toBeNull();
    expect(
      remainingSeconds([
        { at: 0, progress: 0 },
        { at: 2000, progress: 0.1 },
      ])
    ).toBeNull();
  });

  it("一定の速さなら、残りを割り出す", () => {
    // 10秒で10% → 残り90%は90秒
    const s: EtaSample[] = [
      { at: 0, progress: 0 },
      { at: 10_000, progress: 0.1 },
    ];
    expect(remainingSeconds(s)).toBe(90);
  });

  it("直近の速さを使う", () => {
    let s: EtaSample[] = [];
    // 始めの10分はゆっくり、最近の1分は速い
    s = pushSample(s, { at: 0, progress: 0 });
    s = pushSample(s, { at: 600_000, progress: 0.1 });
    s = pushSample(s, { at: 660_000, progress: 0.2 });
    // 直近は 1分で10% → 残り80%は8分
    expect(remainingSeconds(s)).toBe(480);
  });

  it("直近で進んでいなければ、始めからの平均にする", () => {
    let s: EtaSample[] = [];
    s = pushSample(s, { at: 0, progress: 0 });
    s = pushSample(s, { at: 300_000, progress: 0.5 });
    s = pushSample(s, { at: 600_000, progress: 0.5 });
    // 10分で50% → 残りも10分
    expect(remainingSeconds(s)).toBe(600);
  });
});

describe("pushSample", () => {
  it("古い観測は捨てるが、始めの1つは残す", () => {
    let s: EtaSample[] = [];
    for (let i = 0; i <= 10; i++) {
      s = pushSample(s, { at: i * 60_000, progress: i / 10 });
    }
    expect(s[0].at).toBe(0);
    // 始め + 直近2分 (8分・9分・10分)
    expect(s.map((x) => x.at / 60_000)).toEqual([0, 8, 9, 10]);
  });
});

describe("時間の書き方", () => {
  it("経過時間", () => {
    expect(fmtDuration(45)).toBe("45秒");
    expect(fmtDuration(200)).toBe("3分20秒");
    expect(fmtDuration(3900)).toBe("1時間5分");
  });

  it("残り時間は丸める", () => {
    expect(fmtRemaining(30)).toBe("1分以内");
    expect(fmtRemaining(61)).toBe("約2分");
    expect(fmtRemaining(3600 + 7 * 60)).toBe("約1時間10分");
    expect(fmtRemaining(2 * 3600 + 58 * 60)).toBe("約3時間");
  });
});
