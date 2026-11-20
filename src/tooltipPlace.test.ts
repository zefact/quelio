import { describe, expect, it } from "vitest";
import { placeTooltip } from "./tooltipPlace";

const view = { width: 1000, height: 800 };
const tip = { width: 200, height: 40 };
/** 画面の中ほどにある 100x30 のボタン */
const mid = { left: 400, top: 300, right: 500, bottom: 330 };

describe("placeTooltip", () => {
  it("既定は下に出し、右端をそろえる", () => {
    expect(placeTooltip(mid, tip, view, "right")).toEqual({
      left: 300,
      top: 338,
    });
  });

  it("tooltip-left なら左端をそろえる", () => {
    expect(placeTooltip(mid, tip, view, "left")).toEqual({
      left: 400,
      top: 338,
    });
  });

  it("下に入らなければ上に出す", () => {
    const low = { left: 400, top: 760, right: 500, bottom: 790 };
    expect(placeTooltip(low, tip, view, "right").top).toBe(760 - 8 - 40);
  });

  it("上にも下にも入らないときは、広いほうに出して画面に収める", () => {
    const tall = { width: 200, height: 700 };
    // 下のほうが広い: 下に出し、画面の下端に収まるよう上へずらす
    const nearTop = { left: 400, top: 100, right: 500, bottom: 130 };
    expect(placeTooltip(nearTop, tall, view, "right").top).toBe(800 - 8 - 700);
    // 上のほうが広い: 上に出し、画面の上端で止める
    const nearBottom = { left: 400, top: 600, right: 500, bottom: 630 };
    expect(placeTooltip(nearBottom, tall, view, "right").top).toBe(8);
  });

  it("左端で切れるときは画面の中へ押し戻す", () => {
    const left = { left: 10, top: 300, right: 40, bottom: 330 };
    expect(placeTooltip(left, tip, view, "right").left).toBe(8);
  });

  it("右端で切れるときは画面の中へ押し戻す", () => {
    const right = { left: 950, top: 300, right: 990, bottom: 330 };
    expect(placeTooltip(right, tip, view, "left").left).toBe(1000 - 8 - 200);
  });
});
