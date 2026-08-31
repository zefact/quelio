/**
 * 接続中のタブの上部に共通で出るもの。
 *
 * SQL側 (SessionView) と Valkey側 (KvSessionView) で
 * 同じ見た目のものを別々に書いていたため、
 * 片方だけ直すと表示が食い違っていた。
 * 中身が完全に同じところだけをここへ集める
 * (データベースの選び方は両者で違うので、それぞれの画面に残す)
 */
import { badgeStyle, dbBadgeLabel, profileColor } from "../colors";
import type { ConnectionProfile } from "../types";

/** 接続先の見出し (種類のバッジ + 名前 + つなぎ先) */
export function ConnectionChip({
  profile,
  /** SQLite のときに出すファイルパス (他のDBでは使わない) */
  filePath,
}: {
  profile: ConnectionProfile;
  filePath?: string;
}) {
  // SQLiteはファイルそのものが1つのDBなので、ホスト:ポートを持たない
  const isSqlite = profile.dbType === "sqlite";
  return (
    <>
      <span
        className={`db-badge ${profile.dbType}`}
        style={badgeStyle(profileColor(profile))}
      >
        {dbBadgeLabel(profile.dbType)}
      </span>
      <div className="session-conn">
        <span className="session-name">{profile.name || "(無名)"}</span>
        <span className="session-host mono">
          {isSqlite ? (
            <span className="session-host-text" title={filePath}>
              {filePath}
            </span>
          ) : (
            <>
              {profile.ssh?.enabled && <span className="ssh-chip">SSH</span>}
              <span
                className="session-host-text"
                title={`${profile.host}:${profile.port}`}
              >
                {profile.host}:{profile.port}
              </span>
            </>
          )}
        </span>
      </div>
    </>
  );
}

/** サーバーの情報 (バージョン・文字コードなど) を並べたチップ */
export function ServerInfo({ items }: { items: [string, string][] }) {
  if (items.length === 0) return null;
  return (
    <div className="server-info">
      {items.map(([label, value]) => (
        <span className="info-chip" key={label} title={`${label}: ${value}`}>
          <span className="info-chip-label">{label}</span>
          <span className="info-chip-value mono">{value}</span>
        </span>
      ))}
    </div>
  );
}
