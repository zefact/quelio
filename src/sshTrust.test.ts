import { describe, expect, it } from "vitest";
import { parseUnknownHost, stripHostMark } from "./sshTrust";

const err =
  "SSH_HOST_UNKNOWN\tbastion.example.com\t22\tSHA256:abc123\n" +
  "SSHサーバー (bastion.example.com:22) へは初めての接続です。\n" +
  "SHA256:abc123";

describe("parseUnknownHost", () => {
  it("ホスト・ポート・フィンガープリントを取り出す", () => {
    const found = parseUnknownHost(err);
    expect(found).not.toBeNull();
    expect(found?.host).toBe("bastion.example.com");
    expect(found?.port).toBe(22);
    expect(found?.fingerprint).toBe("SHA256:abc123");
    expect(found?.message.startsWith("SSHサーバー")).toBe(true);
  });

  it("普通のエラーはnull", () => {
    expect(parseUnknownHost("接続できません: timeout")).toBeNull();
    // しるしだけで中身が足りないものも受け付けない
    expect(parseUnknownHost("SSH_HOST_UNKNOWN\thost")).toBeNull();
  });
});

describe("stripHostMark", () => {
  it("しるしの行を落とす", () => {
    expect(stripHostMark(err).startsWith("SSHサーバー")).toBe(true);
  });

  it("普通のエラーはそのまま", () => {
    expect(stripHostMark("失敗しました")).toBe("失敗しました");
  });
});
