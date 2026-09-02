import { describe, expect, it } from "vitest";
import { isLocalHost, tlsWarning, viaTunnel } from "./tlsWarning";
import type { ConnectionProfile, SslMode } from "./types";

function conn(over: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: "c1",
    name: "test",
    dbType: "mysql",
    host: "db.example.com",
    port: 3306,
    user: "root",
    password: "",
    ...over,
  } as ConnectionProfile;
}

describe("isLocalHost", () => {
  it("手元の書き方をひととおり見分ける", () => {
    for (const h of ["localhost", "127.0.0.1", "::1", "[::1]", " LOCALHOST ", ""]) {
      expect(isLocalHost(h)).toBe(true);
    }
    expect(isLocalHost("db.example.com")).toBe(false);
    expect(isLocalHost("192.168.1.200")).toBe(false);
  });
});

describe("viaTunnel", () => {
  it("SSHとプロキシのどちらでも経由とみなす", () => {
    expect(viaTunnel({ ssh: undefined, proxy: undefined })).toBe(false);
    expect(
      viaTunnel({
        ssh: { enabled: false, host: "", port: 22, user: "", keyPath: "" },
        proxy: undefined,
      })
    ).toBe(false);
    expect(
      viaTunnel({
        ssh: { enabled: true, host: "b", port: 22, user: "u", keyPath: "k" },
        proxy: undefined,
      })
    ).toBe(true);
  });
});

describe("tlsWarning", () => {
  it("検証しない設定は注意を出す", () => {
    for (const mode of ["", "disable", "require", undefined] as (SslMode | undefined)[]) {
      expect(tlsWarning(conn({ sslMode: mode }))).toBe(true);
    }
  });

  it("検証する設定なら出さない", () => {
    expect(tlsWarning(conn({ sslMode: "verify-ca" }))).toBe(false);
    expect(tlsWarning(conn({ sslMode: "verify-full" }))).toBe(false);
  });

  it("手元のDBには出さない (ネットワークに出ない)", () => {
    expect(tlsWarning(conn({ host: "127.0.0.1" }))).toBe(false);
  });

  it("SSH・SSM経由には出さない (経路が守られている)", () => {
    expect(
      tlsWarning(
        conn({
          ssh: { enabled: true, host: "bastion", port: 22, user: "u", keyPath: "k" },
        })
      )
    ).toBe(false);
    expect(
      tlsWarning(
        conn({
          proxy: {
            enabled: true,
            kind: "ssm",
            target: "i-123",
            region: "",
            profile: "",
            instance: "",
            credentialsPath: "",
            autoIam: false,
            commandPath: "",
          },
        })
      )
    ).toBe(false);
  });

  it("SQLiteとValkeyには出さない", () => {
    expect(tlsWarning(conn({ dbType: "sqlite" }))).toBe(false);
    expect(tlsWarning(conn({ dbType: "valkey" }))).toBe(false);
  });

  it("PostgreSQLでも同じ判定になる", () => {
    expect(tlsWarning(conn({ dbType: "postgresql", port: 5432 }))).toBe(true);
    expect(
      tlsWarning(conn({ dbType: "postgresql", sslMode: "verify-full" }))
    ).toBe(false);
  });
});
