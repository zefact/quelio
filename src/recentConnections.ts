/**
 * ホーム (未接続タブ) に並べる接続先の選び方。
 *
 * よく使うものと、直前まで触っていたものへ最短で戻れるようにする
 */
import type { ConnectionProfile } from "./types";

/** ホームに出す「最近つないだ接続」の数 */
export const RECENT_LIMIT = 6;

/** ピン留めした接続 (一覧の並び順のまま) */
export function pinnedConnections(
  list: ConnectionProfile[]
): ConnectionProfile[] {
  return list.filter((c) => c.pinned);
}

/**
 * 最近つないだ接続。
 *
 * ピン留めしたものは上の段に出るので、ここには入れない。
 * 一度も繋いでいないものは「最近」ではないので出さない
 */
export function recentConnections(
  list: ConnectionProfile[],
  limit = RECENT_LIMIT
): ConnectionProfile[] {
  return list
    .filter((c) => !c.pinned && c.lastUsedAt)
    .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))
    .slice(0, limit);
}

/** 「3日前」のような、ざっくりした経過の表示 */
export function sinceLabel(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.floor((now - t) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}日前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}か月前`;
  return `${Math.floor(month / 12)}年前`;
}
