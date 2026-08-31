/**
 * 未接続タブのホーム。
 *
 * 起動して最初に見る画面なので、よく使う接続先へ最短で戻れるようにする。
 * ここから選べば、一覧をたどって開く手間が要らない
 */
import { badgeStyle, dbBadgeLabel, profileColor } from "../colors";
import { envColor, envLabel } from "../types";
import {
  pinnedConnections,
  recentConnections,
  sinceLabel,
} from "../recentConnections";
import type { ConnectionProfile } from "../types";

interface Props {
  connections: ConnectionProfile[];
  /** 選んだ接続先へ繋ぐ */
  onConnect: (profile: ConnectionProfile) => void;
  /** ピン留めの付け外し */
  onTogglePin: (id: string, pinned: boolean) => void;
  /** 新しい接続先を作る画面へ */
  onNew: () => void;
  /** お試し用のサンプルDBを開く */
  onOpenSample: () => void;
  /** 接続中か (二重に押させない) */
  connecting: boolean;
}

/** 接続先1件のカード */
function Card({
  conn,
  onConnect,
  onTogglePin,
  connecting,
}: {
  conn: ConnectionProfile;
  onConnect: (p: ConnectionProfile) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  connecting: boolean;
}) {
  const sub =
    conn.dbType === "sqlite"
      ? (conn.database ?? "")
      : `${conn.host}:${conn.port}${conn.database ? ` / ${conn.database}` : ""}`;
  return (
    <div className="home-card">
      <button
        className="home-card-main"
        disabled={connecting}
        onClick={() => onConnect(conn)}
        title={`${conn.name || conn.host} へ接続`}
      >
        <span
          className={`db-badge ${conn.dbType}`}
          style={badgeStyle(profileColor(conn))}
        >
          {dbBadgeLabel(conn.dbType)}
        </span>
        <span className="home-card-body">
          <span className="home-card-name">
            {conn.name || `${conn.host}:${conn.port}`}
            {conn.env && (
              <span
                className="home-card-env"
                style={{
                  color: envColor(conn.env),
                  borderColor: envColor(conn.env),
                }}
              >
                {envLabel(conn.env)}
              </span>
            )}
          </span>
          <span className="home-card-sub mono">{sub}</span>
        </span>
        {conn.lastUsedAt && (
          <span className="home-card-since">{sinceLabel(conn.lastUsedAt)}</span>
        )}
      </button>
      <button
        className={"home-pin" + (conn.pinned ? " on" : "")}
        title={conn.pinned ? "ピン留めを外す" : "ピン留めする"}
        onClick={() => onTogglePin(conn.id, !conn.pinned)}
      >
        {conn.pinned ? "★" : "☆"}
      </button>
    </div>
  );
}

export function PickerHome({
  connections,
  onConnect,
  onTogglePin,
  onNew,
  onOpenSample,
  connecting,
}: Props) {
  const pinned = pinnedConnections(connections);
  const recent = recentConnections(connections);

  return (
    <div className="picker-home">
      <header className="main-head">
        <h1>ようこそ</h1>
        <span className="profile-id">接続先を選ぶか、新しく作ってください</span>
      </header>

      {pinned.length > 0 && (
        <section className="home-group">
          <h2 className="home-group-title">ピン留めした接続</h2>
          <div className="home-cards">
            {pinned.map((c) => (
              <Card
                key={c.id}
                conn={c}
                onConnect={onConnect}
                onTogglePin={onTogglePin}
                connecting={connecting}
              />
            ))}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section className="home-group">
          <h2 className="home-group-title">最近つないだ接続</h2>
          <div className="home-cards">
            {recent.map((c) => (
              <Card
                key={c.id}
                conn={c}
                onConnect={onConnect}
                onTogglePin={onTogglePin}
                connecting={connecting}
              />
            ))}
          </div>
        </section>
      )}

      {pinned.length === 0 && recent.length === 0 && (
        <p className="home-empty">
          左の一覧から接続先を選ぶと、次回からここに出ます。
          よく使うものは ☆ でピン留めできます
        </p>
      )}

      <div className="home-actions">
        <button className="btn-secondary" onClick={onNew}>
          新しい接続を作る
        </button>
        <button className="btn-ghost" onClick={onOpenSample}>
          サンプルDBで試す
        </button>
      </div>
    </div>
  );
}
