import { describe, expect, it } from "vitest";
import { isProfileDirty } from "./connectionDirty";
import { emptyProfile, emptySsh } from "./types";
import type { ConnectionProfile } from "./types";

/** 保存済みの接続先の見本 */
function saved(): ConnectionProfile {
  return {
    ...emptyProfile(),
    id: "c1",
    name: "社内MySQL",
    host: "db.local",
    user: "app",
    passwordSaved: true,
  };
}

describe("isProfileDirty", () => {
  it("同じ中身なら書きかけではない", () => {
    expect(isProfileDirty(saved(), saved())).toBe(false);
  });

  it("名前やホストを変えたら書きかけ", () => {
    expect(isProfileDirty({ ...saved(), name: "別名" }, saved())).toBe(true);
    expect(isProfileDirty({ ...saved(), host: "db2.local" }, saved())).toBe(true);
  });

  it("パスワードを入れ直したら書きかけ", () => {
    expect(
      isProfileDirty(
        { ...saved(), password: "x", passwordSaved: false },
        saved()
      )
    ).toBe(true);
  });

  it("色・フォルダ・ピン留め・接続した時刻の違いは見ない", () => {
    const cur = {
      ...saved(),
      color: "#ff0000",
      folderId: "f1",
      pinned: true,
      lastUsedAt: "2026-11-19T00:00:00Z",
    };
    expect(isProfileDirty(cur, saved())).toBe(false);
  });

  it("未設定・空文字・false は同じとみなす", () => {
    const base = { ...saved(), readOnly: undefined, database: undefined };
    expect(
      isProfileDirty({ ...base, readOnly: false, database: "" }, base)
    ).toBe(false);
  });

  it("使っていないSSHの中身は見ない", () => {
    const base = { ...saved(), ssh: undefined };
    expect(isProfileDirty({ ...base, ssh: emptySsh() }, base)).toBe(false);
    expect(
      isProfileDirty({ ...base, ssh: { ...emptySsh(), host: "bastion" } }, base)
    ).toBe(false);
  });

  it("SSHをオンにしたら書きかけ", () => {
    const base = { ...saved(), ssh: emptySsh() };
    expect(
      isProfileDirty({ ...base, ssh: { ...emptySsh(), enabled: true } }, base)
    ).toBe(true);
  });

  it("新しく作っている途中は、空のフォームと比べる", () => {
    expect(isProfileDirty(emptyProfile(), emptyProfile())).toBe(false);
    expect(
      isProfileDirty({ ...emptyProfile(), name: "新規" }, emptyProfile())
    ).toBe(true);
  });

  it("比べる相手が無ければ書きかけとみなさない", () => {
    expect(isProfileDirty(saved(), null)).toBe(false);
  });
});
