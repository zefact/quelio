import { describe, expect, it } from "vitest";
import { dropIndex, gapOf, slideOf, slideWidth, type TabRect } from "./tabSlide";

/**
 * 幅100・間隔10で4枚並んだタブ。
 * left は 0 / 110 / 220 / 330、中心は 50 / 160 / 270 / 380
 */
function four(): TabRect[] {
  return [0, 110, 220, 330].map((left) => ({ left, width: 100 }));
}

/** 幅がまちまちのタブ (幅60・140・80、間隔10) */
function mixed(): TabRect[] {
  return [
    { left: 0, width: 60 },
    { left: 70, width: 140 },
    { left: 220, width: 80 },
  ];
}

describe("gapOf / slideWidth", () => {
  it("間隔を測る", () => {
    expect(gapOf(four())).toBe(10);
    expect(gapOf(mixed())).toBe(10);
  });

  it("1枚だけなら間隔は0", () => {
    expect(gapOf([{ left: 0, width: 100 }])).toBe(0);
  });

  it("まわりが動く量は「掴んだタブの幅 + 間隔」", () => {
    expect(slideWidth(four(), 0)).toBe(110);
    // 幅がまちまちでも、抜けた場所ぶんちょうど
    expect(slideWidth(mixed(), 1)).toBe(150);
  });
});

describe("dropIndex", () => {
  it("動かしていなければ、その場のまま", () => {
    for (let i = 0; i < 4; i++) {
      expect(dropIndex(four(), i, 0), `${i}枚目`).toBe(i);
    }
  });

  it("幅がまちまちでも、動かしていなければ動かない", () => {
    for (let i = 0; i < 3; i++) {
      expect(dropIndex(mixed(), i, 0), `${i}枚目`).toBe(i);
    }
  });

  it("隣の真ん中を越えるまでは入れ替わらない", () => {
    // 0枚目の右端は100。1枚目の中心160を越えるのは dx=60 から
    expect(dropIndex(four(), 0, 59)).toBe(0);
    expect(dropIndex(four(), 0, 61)).toBe(1);
  });

  it("左へ動かすときも、隣の真ん中が境目", () => {
    // 1枚目の左端は110。0枚目の中心50を下回るのは dx=-60 から
    expect(dropIndex(four(), 1, -59)).toBe(1);
    expect(dropIndex(four(), 1, -61)).toBe(0);
  });

  it("大きく動かせば端まで行く", () => {
    expect(dropIndex(four(), 0, 500)).toBe(3);
    expect(dropIndex(four(), 3, -500)).toBe(0);
  });

  it("端より外へは行かない", () => {
    expect(dropIndex(four(), 3, 9999)).toBe(3);
    expect(dropIndex(four(), 0, -9999)).toBe(0);
  });
});

describe("slideOf", () => {
  it("掴んでいるタブは、指の動きぶんそのまま動く", () => {
    expect(slideOf(four(), 1, 2, 77, 1)).toBe(77);
  });

  it("右へ運ぶと、間のタブは左へ詰める", () => {
    const r = four();
    // 0枚目を2の位置へ: 1と2が左へ、3はそのまま
    expect(slideOf(r, 0, 2, 200, 1)).toBe(-110);
    expect(slideOf(r, 0, 2, 200, 2)).toBe(-110);
    expect(slideOf(r, 0, 2, 200, 3)).toBe(0);
  });

  it("左へ運ぶと、間のタブは右へ寄る", () => {
    const r = four();
    // 3枚目を1の位置へ: 1と2が右へ、0はそのまま
    expect(slideOf(r, 3, 1, -200, 0)).toBe(0);
    expect(slideOf(r, 3, 1, -200, 1)).toBe(110);
    expect(slideOf(r, 3, 1, -200, 2)).toBe(110);
  });

  it("落とす先が変わらないうちは、掴んだタブ以外は動かない", () => {
    const r = four();
    for (const i of [0, 2, 3]) {
      expect(slideOf(r, 1, 1, 20, i), `${i}枚目`).toBe(0);
    }
  });

  it("ずらした先が、隣がもともと居た場所とそろう", () => {
    // 幅がまちまちでも、詰めたあとの位置が元の並びと重ならないこと
    const r = mixed();
    const w = slideWidth(r, 0);
    // 1枚目は左へ w だけ詰めるので、0枚目が居た場所から始まる
    expect(r[1].left - w).toBe(r[0].left);
  });
});
