import { describe, expect, it } from "vitest";
import { tabLabel, tabState, tabTitle } from "./tabLabel";
import type { TabLabelSource } from "./tabLabel";
import { emptyProfile } from "./types";

function tab(over: Partial<TabLabelSource> = {}): TabLabelSource {
  return {
    connected: false,
    busy: null,
    profile: { ...emptyProfile(), name: "社内MySQL", host: "db.local", id: "c1" },
    ...over,
  };
}

describe("tabState", () => {
  it("接続済み・接続中・未接続を分ける", () => {
    expect(tabState(tab({ connected: true }))).toBe("connected");
    expect(tabState(tab({ busy: "connect" }))).toBe("connecting");
    expect(tabState(tab({ busy: "test" }))).toBe("idle");
  });

  it("接続済みで切断の印があれば lost (未接続のタブには付けない)", () => {
    expect(tabState(tab({ connected: true }), true)).toBe("lost");
    expect(tabState(tab(), true)).toBe("idle");
  });
});

describe("tabLabel", () => {
  it("接続済みは接続名", () => {
    expect(tabLabel(tab({ connected: true }))).toBe("社内MySQL");
  });

  it("接続済みで名前が空なら (無名)", () => {
    const p = { ...emptyProfile(), id: "c1" };
    expect(tabLabel(tab({ connected: true, profile: p }))).toBe("(無名)");
  });

  it("未接続でも、編集中の接続先があればその名前", () => {
    expect(tabLabel(tab())).toBe("社内MySQL");
  });

  it("接続中も接続先の名前", () => {
    expect(tabLabel(tab({ busy: "connect" }))).toBe("社内MySQL");
  });

  it("何も選んでいなければ「新しい接続」", () => {
    expect(tabLabel(tab({ profile: emptyProfile() }))).toBe("新しい接続");
  });

  it("新規作成中で名前が空なら「新しい接続」", () => {
    expect(
      tabLabel(tab({ profile: emptyProfile(), newConnForm: true }))
    ).toBe("新しい接続");
  });
});

describe("tabTitle", () => {
  it("接続済みは「接続名 / ホスト:ポート」", () => {
    expect(tabTitle(tab({ connected: true }))).toBe("社内MySQL / db.local:3306");
  });

  it("SQLiteはファイルを出す", () => {
    const p = { ...emptyProfile(), id: "s", name: "見本", dbType: "sqlite" as const, database: "/tmp/a.db" };
    expect(tabTitle(tab({ connected: true, profile: p }))).toBe("見本 / /tmp/a.db");
  });

  it("接続中・未接続は状態も添える", () => {
    expect(tabTitle(tab({ busy: "connect" }))).toContain("接続中…");
    expect(tabTitle(tab())).toContain("未接続");
  });

  it("切断されたタブは接続し直せることを添える", () => {
    expect(tabTitle(tab({ connected: true }), true)).toBe(
      "社内MySQL / db.local:3306\n接続が切れました。クリックして接続し直す"
    );
  });

  it("何も選んでいないタブ", () => {
    expect(tabTitle(tab({ profile: emptyProfile() }))).toBe("接続先を選んでいます");
  });
});
