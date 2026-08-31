import { describe, expect, it } from "vitest";
import { filterActions } from "./quickActions";
import type { QuickAction } from "./quickActions";

const noop = () => {};
const actions: QuickAction[] = [
  { id: "new-tab", label: "新しいタブ", keywords: "new tab", run: noop },
  { id: "settings", label: "設定を開く", keywords: "settings config", run: noop },
  { id: "er", label: "ER図を開く", keywords: "er diagram", run: noop },
];

describe("⌘Kのアクション絞り込み", () => {
  it("空のときは何も出さない (接続先の一覧を邪魔しない)", () => {
    expect(filterActions(actions, "")).toEqual([]);
    expect(filterActions(actions, "   ")).toEqual([]);
  });

  it("日本語の名前で引ける", () => {
    expect(filterActions(actions, "設定").map((a) => a.id)).toEqual(["settings"]);
  });

  it("別名 (英語) でも引ける", () => {
    expect(filterActions(actions, "config").map((a) => a.id)).toEqual(["settings"]);
    expect(filterActions(actions, "tab").map((a) => a.id)).toEqual(["new-tab"]);
  });

  it("大文字小文字を区別しない", () => {
    expect(filterActions(actions, "ER").map((a) => a.id)).toEqual(["er"]);
    expect(filterActions(actions, "Diagram").map((a) => a.id)).toEqual(["er"]);
  });

  it("該当が無ければ空", () => {
    expect(filterActions(actions, "zzz")).toEqual([]);
  });
});
