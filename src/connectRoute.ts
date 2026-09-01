/**
 * 接続の経路 (直接 / SSH踏み台 / 外部CLI) の選び方。
 *
 * 同時に2つ使うことはないので、片方を選んだらもう片方は必ず落とす。
 * 入力した内容は消さずに残す (経路を戻したときに打ち直さなくて済む)
 */
import { emptyProxy, emptySsh } from "./types";
import type { ConnectionProfile } from "./types";

export type ConnectRoute = "none" | "ssh" | "ssm" | "cloudsql";

export const ROUTES: [ConnectRoute, string][] = [
  ["none", "直接つなぐ"],
  ["ssh", "SSH踏み台を経由"],
  ["ssm", "AWS SSM (ポート転送)"],
  ["cloudsql", "Cloud SQL Auth Proxy"],
];

/** 今どの経路になっているか */
export function routeOf(profile: ConnectionProfile): ConnectRoute {
  if (profile.proxy?.enabled) {
    return profile.proxy.kind === "cloudsql" ? "cloudsql" : "ssm";
  }
  if (profile.ssh?.enabled) return "ssh";
  return "none";
}

/** 経路を切り替える (使わないほうは必ず落とす) */
export function applyRoute(
  profile: ConnectionProfile,
  route: ConnectRoute
): ConnectionProfile {
  const ssh = { ...(profile.ssh ?? emptySsh()), enabled: route === "ssh" };
  const proxy = {
    ...(profile.proxy ?? emptyProxy()),
    enabled: route === "ssm" || route === "cloudsql",
    kind: route === "cloudsql" ? ("cloudsql" as const) : ("ssm" as const),
  };
  return { ...profile, ssh, proxy };
}

/** 一覧に出す短い印 (経路を使っていなければ空) */
export function routeChip(profile: ConnectionProfile): string {
  switch (routeOf(profile)) {
    case "ssh":
      return "SSH";
    case "ssm":
      return "SSM";
    case "cloudsql":
      return "Cloud SQL";
    default:
      return "";
  }
}
