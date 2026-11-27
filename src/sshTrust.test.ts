import { describe, expect, it } from "vitest";
import { parseHostAsk, stripHostMark } from "./sshTrust";

const unknownErr =
  "SSH_HOST_UNKNOWN\tbastion.example.com\t22\tSHA256:abc123\n" +
  "SSHサーバー (bastion.example.com:22) へは初めての接続です。\n" +
  "SHA256:abc123";

const changedErr =
  "SSH_HOST_CHANGED\tbastion.example.com\t2222\tSHA256:new\tSHA256:old\n" +
  "SSHサーバー (bastion.example.com:2222) のホスト鍵が前回接続時から変わっています。";

describe("parseHostAsk", () => {
  it("初回接続: ホスト・ポート・フィンガープリントを取り出す", () => {
    const found = parseHostAsk(unknownErr);
    expect(found).not.toBeNull();
    expect(found?.kind).toBe("unknown");
    expect(found?.host).toBe("bastion.example.com");
    expect(found?.port).toBe(22);
    expect(found?.fingerprint).toBe("SHA256:abc123");
    expect(found?.stored).toBeNull();
    expect(found?.message.startsWith("SSHサーバー")).toBe(true);
  });

  it("鍵が変わったとき: 今回と記録済みの値を取り出す", () => {
    const found = parseHostAsk(changedErr);
    expect(found?.kind).toBe("changed");
    expect(found?.port).toBe(2222);
    expect(found?.fingerprint).toBe("SHA256:new");
    expect(found?.stored).toBe("SHA256:old");
  });

  it("普通のエラーはnull", () => {
    expect(parseHostAsk("接続できません: timeout")).toBeNull();
    // しるしだけで中身が足りないものも受け付けない
    expect(parseHostAsk("SSH_HOST_UNKNOWN\thost")).toBeNull();
    // 鍵が変わったのに記録済みの値が無いものも受け付けない
    expect(parseHostAsk("SSH_HOST_CHANGED\thost\t22\tSHA256:new")).toBeNull();
  });
});

describe("stripHostMark", () => {
  it("しるしの行を落とす", () => {
    expect(stripHostMark(unknownErr).startsWith("SSHサーバー")).toBe(true);
    expect(stripHostMark(changedErr).startsWith("SSHサーバー")).toBe(true);
  });

  it("普通のエラーはそのまま", () => {
    expect(stripHostMark("失敗しました")).toBe("失敗しました");
  });
});
