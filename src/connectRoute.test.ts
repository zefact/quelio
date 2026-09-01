import { describe, expect, it } from "vitest";
import { applyRoute, routeChip, routeOf } from "./connectRoute";
import { emptyProfile } from "./types";
import type { ConnectionProfile } from "./types";

function base(): ConnectionProfile {
  return { ...emptyProfile(), host: "db.internal", port: 3306 };
}

describe("接続の経路", () => {
  it("何も立っていなければ直接つなぐ", () => {
    expect(routeOf(base())).toBe("none");
    expect(routeChip(base())).toBe("");
  });

  it("SSHとCLIは同時に立たない", () => {
    const ssh = applyRoute(base(), "ssh");
    expect(ssh.ssh?.enabled).toBe(true);
    expect(ssh.proxy?.enabled).toBe(false);

    const ssm = applyRoute(ssh, "ssm");
    expect(ssm.ssh?.enabled).toBe(false);
    expect(ssm.proxy?.enabled).toBe(true);
    expect(ssm.proxy?.kind).toBe("ssm");
  });

  it("SSMとCloud SQLは種類で切り替える", () => {
    const p = applyRoute(base(), "cloudsql");
    expect(p.proxy?.kind).toBe("cloudsql");
    expect(routeOf(p)).toBe("cloudsql");
    expect(routeOf(applyRoute(p, "ssm"))).toBe("ssm");
  });

  it("直接つなぐに戻すと両方落ちる", () => {
    const p = applyRoute(applyRoute(base(), "ssm"), "none");
    expect(p.ssh?.enabled).toBe(false);
    expect(p.proxy?.enabled).toBe(false);
    expect(routeOf(p)).toBe("none");
  });

  it("経路を切り替えても入力した内容は消さない", () => {
    let p = applyRoute(base(), "ssh");
    p = { ...p, ssh: { ...p.ssh!, host: "bastion.example.com", user: "ec2-user" } };
    p = applyRoute(p, "ssm");
    p = { ...p, proxy: { ...p.proxy!, target: "i-abc" } };
    // SSHへ戻しても、打ち込んだ踏み台の設定は残っている
    const back = applyRoute(p, "ssh");
    expect(back.ssh?.host).toBe("bastion.example.com");
    expect(back.proxy?.target).toBe("i-abc");
  });

  it("一覧に出す印を返す", () => {
    expect(routeChip(applyRoute(base(), "ssh"))).toBe("SSH");
    expect(routeChip(applyRoute(base(), "ssm"))).toBe("SSM");
    expect(routeChip(applyRoute(base(), "cloudsql"))).toBe("Cloud SQL");
  });
});
