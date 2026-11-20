/**
 * 未接続タブのホーム。
 *
 * 起動して最初に見る画面なので、よく使う接続先へ最短で戻れるようにする。
 * ここから選べば、一覧をたどって開く手間が要らない
 */
import { useState } from "react";
import { openCsvWindow, openEr } from "../api";
import { badgeStyle, dbBadgeLabel, profileColor } from "../colors";
import { CsvIcon } from "./CsvIcon";
import { ErIcon } from "./ErIcon";
import { IconButton } from "./IconButton";
import { MOD } from "../keyLabel";
import { envColor, envLabel } from "../types";
import { envListLabel } from "../connectionEnvHint";
import {
  pinnedConnections,
  recentConnections,
  sinceLabel,
} from "../recentConnections";
import type { ConnectionProfile } from "../types";

interface Props {
  connections: ConnectionProfile[];
  /** 選んだ接続先へ接続する */
  onConnect: (profile: ConnectionProfile) => void;
  /** ピン留めの付け外し */
  onTogglePin: (id: string, pinned: boolean) => void;
  /**
   * 「最近接続した接続先」から外す。
   *
   * 接続先そのものは残し、最後に接続した時刻だけを消す
   */
  onForget: (id: string) => void;
  /** 新しい接続先を作る画面へ */
  onNew: () => void;
  /** お試し用のサンプルDBを開く */
  onOpenSample: () => void;
  /** ヘルプを開く */
  onOpenHelp: () => void;
  /** 接続中か (二重に押させない) */
  connecting: boolean;
  /** 接続しに行っている接続先 (そのカードに回る印を出す) */
  connectingId: string | null;
  /** ホームから接続して失敗したときの理由 */
  error: string | null;
  /** 失敗した接続先の設定を開く */
  onEditFailed: () => void;
}

/** 接続先1件のカード */
function Card({
  conn,
  onConnect,
  onTogglePin,
  onForget,
  connecting,
  busy,
}: {
  conn: ConnectionProfile;
  onConnect: (p: ConnectionProfile) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  /** 「最近」から外す (渡さなければボタンを出さない) */
  onForget?: (id: string) => void;
  connecting: boolean;
  /** このカードの接続先へ接続しに行っているところか */
  busy: boolean;
}) {
  const sub =
    conn.dbType === "sqlite"
      ? (conn.database ?? "")
      : `${conn.host}:${conn.port}${conn.database ? ` / ${conn.database}` : ""}`;
  return (
    <div className={"home-card" + (busy ? " connecting" : "")}>
      <button
        // 接続中は押せないので説明を出さない。has-tooltip を付けたままだと、
        // 押せないときの見た目がカード全体を薄くする形から文字色だけ弱める形に変わってしまう
        className={"home-card-main" + (connecting ? "" : " has-tooltip tooltip-left")}
        disabled={connecting}
        onClick={() => onConnect(conn)}
        data-tooltip={`${conn.name || conn.host} へ接続する`}
        aria-busy={busy}
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
            {conn.env ? (
              <span
                className="home-card-env"
                style={{
                  color: envColor(conn.env),
                  borderColor: envColor(conn.env),
                }}
              >
                {envLabel(conn.env)}
              </span>
            ) : (
              /* 未設定のままだと本番を本番として扱えないので、そうと分かるようにする */
              <span className="home-card-env unset">
                {envListLabel(conn.env)}
              </span>
            )}
          </span>
          <span className="home-card-sub mono">{sub}</span>
        </span>
        {busy ? (
          <span className="home-card-since">
            <span className="spinner accent" /> 接続中…
          </span>
        ) : (
          conn.lastUsedAt && (
            <span className="home-card-since">
              {sinceLabel(conn.lastUsedAt)}
            </span>
          )
        )}
      </button>
      <IconButton
        className={"home-pin" + (conn.pinned ? " on" : "")}
        label={conn.pinned ? "ピン留めを外す" : "ピン留めする"}
        aria-pressed={!!conn.pinned}
        onClick={() => onTogglePin(conn.id, !conn.pinned)}
      >
        {conn.pinned ? "★" : "☆"}
      </IconButton>
      {onForget && (
        <IconButton
          className="home-pin home-forget"
          label="この一覧から消す (接続先は残ります)"
          onClick={() => onForget(conn.id)}
        >
          ✕
        </IconButton>
      )}
    </div>
  );
}

export function PickerHome({
  connections,
  onConnect,
  onTogglePin,
  onForget,
  onNew,
  onOpenSample,
  onOpenHelp,
  connecting,
  connectingId,
  error,
  onEditFailed,
}: Props) {
  const pinned = pinnedConnections(connections);
  const recent = recentConnections(connections);
  /** CSVエディタを開けなかったときの知らせ */
  const [toolError, setToolError] = useState<string | null>(null);
  /** 接続先がまだ1件も無い (初めて起動したとき) */
  const firstRun = connections.length === 0;

  return (
    <div className="picker-home">
      <header className="main-head">
        <h1>ようこそ</h1>
        <span className="profile-id">
          {firstRun
            ? "まずは接続先を作るか、サンプルDBで試してください"
            : "接続先を選ぶか、新しく作ってください"}
        </span>
      </header>

      {error && (
        <div className="result-banner ng">
          <span className="dot" aria-hidden />
          <strong>接続できませんでした</strong>
          <span className="result-detail">{error}</span>
          <span className="toolbar-spacer" />
          <button className="btn-ghost" onClick={onEditFailed}>
            接続先の設定を開く
          </button>
        </div>
      )}

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
                busy={c.id === connectingId}
              />
            ))}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section className="home-group">
          <h2 className="home-group-title">最近接続した接続先</h2>
          <div className="home-cards">
            {recent.map((c) => (
              <Card
                key={c.id}
                conn={c}
                onConnect={onConnect}
                onTogglePin={onTogglePin}
                onForget={onForget}
                connecting={connecting}
                busy={c.id === connectingId}
              />
            ))}
          </div>
        </section>
      )}

      {pinned.length === 0 && recent.length === 0 && (
        <p className="home-empty">
          {firstRun
            ? "保存した接続先はまだありません。「新しい接続先を作成」から、ホスト・ユーザーなどを入れて保存してください。手元で試すだけなら「サンプルDBで試す」が手軽です。"
            : "左の一覧から接続先を選んで接続すると、次回からここに出ます。よく使うものは ☆ でピン留めでき、✕ でこの一覧から消せます"}
        </p>
      )}

      <div className="home-actions">
        {/* 初めての人が次に押すものが分かるよう、接続先が無いうちは作成を主ボタンにする */}
        <button className={firstRun ? "btn-primary" : "btn-secondary"} onClick={onNew}>
          新しい接続先を作成
        </button>
        <button className="btn-ghost" onClick={onOpenSample}>
          サンプルDBで試す
        </button>
        <button className="btn-ghost" onClick={onOpenHelp}>
          ヘルプ
        </button>
      </div>

      {/* ⌘K はどこにも見えないので、ここで知らせておく */}
      <p className="home-hint">
        <kbd>{MOD}K</kbd> で接続先や操作 (設定・ヘルプ・ER図など) を名前で探して開けます。
        <kbd>{MOD}/</kbd> でキーボードショートカットの一覧を出せます。
      </p>

      {/*
        CSVエディタとER図はデータベースに接続しなくても使うツールなので、
        接続を選ぶ前のこの画面から開けるようにしておく
      */}
      <section className="home-group">
        <h2 className="home-group-title">ツール</h2>
        <button
          className="home-tool"
          onClick={() =>
            void openCsvWindow().catch((e) =>
              setToolError(`CSVエディタを開けませんでした: ${e}`)
            )
          }
        >
          <span className="home-tool-mark">
            <CsvIcon />
          </span>
          <span className="home-tool-body">
            <span className="home-tool-name">CSVエディタ</span>
            <span className="home-tool-sub">
              CSV・固定長ファイルを開いて編集し、2つのファイルを比べます
              (データベースに接続しなくても使えます)
            </span>
          </span>
        </button>
        <button
          className="home-tool"
          onClick={() =>
            void openEr().catch((e) =>
              setToolError(`ER図を開けませんでした: ${e}`)
            )
          }
        >
          <span className="home-tool-mark">
            <ErIcon />
          </span>
          <span className="home-tool-body">
            <span className="home-tool-name">ER図</span>
            <span className="home-tool-sub">
              保存した図を開いて描き、テーブルを置いて線を引きます。
              接続中の接続先があれば、そこからリバースもできます
              (データベースに接続しなくても使えます)
            </span>
          </span>
        </button>
        {toolError && <p className="home-empty">{toolError}</p>}
      </section>
    </div>
  );
}
