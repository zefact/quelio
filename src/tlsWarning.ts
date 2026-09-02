/**
 * 「相手が本物か確かめないまま通信している」接続を見分ける。
 *
 * TLSの既定 (`""`) は「使えれば使う・証明書は検証しない」なので、
 * 途中で盗み見や差し替えをされても気づけない。
 * ただし何にでも警告を出すと読み飛ばされるので、
 * 経路が守られている接続と、手元のDBは対象から外す
 */
import { tlsUnverified } from "./types";
import type { ConnectionProfile } from "./types";

/** 手元 (ネットワークに出ない) の接続先か */
export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "";
}

/** SSH踏み台 / SSM / Cloud SQL Auth Proxy を経由するか */
export function viaTunnel(
  profile: Pick<ConnectionProfile, "ssh" | "proxy">
): boolean {
  return !!profile.ssh?.enabled || !!profile.proxy?.enabled;
}

/**
 * 画面に注意を出すべき接続か。
 *
 * 対象は MySQL / PostgreSQL の直結だけにする。
 * - SQLite … ファイルなので通信しない
 * - Valkey … TLSの入切だけで、検証の段階が無い
 * - SSH/SSM経由 … 経路そのものが暗号化・認証されている
 * - localhost … ネットワークに出ない
 */
export function tlsWarning(profile: ConnectionProfile): boolean {
  if (profile.dbType !== "mysql" && profile.dbType !== "postgresql") {
    return false;
  }
  if (viaTunnel(profile) || isLocalHost(profile.host)) return false;
  return tlsUnverified(profile.sslMode);
}
