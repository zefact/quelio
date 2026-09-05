import { describe, expect, it } from "vitest";
import { createReqSeq } from "./reqSeq";

describe("createReqSeq", () => {
  it("後から始めたほうが最新になる", () => {
    const seq = createReqSeq();
    const a = seq.start("t");
    const b = seq.start("t");
    expect(seq.isLatest("t", a)).toBe(false);
    expect(seq.isLatest("t", b)).toBe(true);
  });

  it("捨てたあとは、待っていたものがすべて古くなる", () => {
    const seq = createReqSeq();
    const a = seq.start("t");
    seq.drop("t");
    expect(seq.isLatest("t", a)).toBe(false);
  });

  it("捨てたあとでも、新しく始めたものは通る", () => {
    const seq = createReqSeq();
    seq.start("t");
    seq.drop("t");
    const b = seq.start("t");
    expect(seq.isLatest("t", b)).toBe(true);
  });

  it("用途が違えば互いに影響しない", () => {
    const seq = createReqSeq();
    const a = seq.start("a");
    seq.start("b");
    seq.drop("b");
    expect(seq.isLatest("a", a)).toBe(true);
  });
});
