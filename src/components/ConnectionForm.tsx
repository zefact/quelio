import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { defaultSshKeyDir } from "../api";
import type {
  ConnectionEnv,
  ConnectionProfile,
  DbType,
  ProxyConfig,
  SshConfig,
  SslMode,
} from "../types";
import {
  DEFAULT_PORTS,
  ENVS,
  SSL_MODES,
  emptyProxy,
  emptySsh,
  tlsUnverified,
} from "../types";
import { applyRoute, ROUTES, routeOf } from "../connectRoute";
import { viaTunnel } from "../tlsWarning";
import type { ConnectRoute } from "../connectRoute";
import { ConfirmDialog } from "./ConfirmDialog";
import { ConnectionProxyFields } from "./ConnectionProxyFields";
import { SelectMenu } from "./SelectMenu";

interface Props {
  profile: ConnectionProfile;
  onChange: (profile: ConnectionProfile) => void;
  onSave: () => void;
  /** 削除する (確認はこのコンポーネントで出す。失敗したら例外を投げること) */
  onDelete: () => void | Promise<void>;
  onTest: () => void;
  onConnect: () => void;
  testing: boolean;
  saving: boolean;
  connecting: boolean;
}

export function ConnectionForm({
  profile,
  onChange,
  onSave,
  onDelete,
  onTest,
  onConnect,
  testing,
  saving,
  connecting,
}: Props) {
  const ssh: SshConfig = profile.ssh ?? emptySsh();
  const proxy: ProxyConfig = profile.proxy ?? emptyProxy();
  /** 直接つなぐか、SSH踏み台か、外部CLI経由か */
  const route = routeOf(profile);
  /** 削除の確認を出しているか (接続先は消すと元に戻せない) */
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = (patch: Partial<ConnectionProfile>) =>
    onChange({ ...profile, ...patch });
  /** パスワード・パスフレーズを入れ直したら「復号できない」状態は解除する */
  /*
   * パスワードを入力し直したときは「保存済み (伏せてある)」の目印を落とす。
   * 落としておかないと、空にして保存しても前の値が復活してしまう
   */
  const setSecret = (patch: Partial<ConnectionProfile>) =>
    onChange({
      ...profile,
      ...patch,
      passwordLocked: false,
      passwordSaved: false,
    });
  const setSsh = (patch: Partial<SshConfig>) =>
    onChange({ ...profile, ssh: { ...ssh, ...patch } });
  const setProxy = (patch: Partial<ProxyConfig>) =>
    onChange({ ...profile, proxy: { ...proxy, ...patch } });
  /** パスフレーズを入れ直したときも「復号できない」状態を解除する */
  const setSshSecret = (patch: Partial<SshConfig>) =>
    onChange({
      ...profile,
      ssh: { ...ssh, ...patch },
      passwordLocked: false,
      passphraseSaved: false,
    });

  const changeDbType = (dbType: DbType) => {
    // ポートが変更前DBの既定値のままなら、新DBの既定値に切り替える
    const patch: Partial<ConnectionProfile> = { dbType };
    if (profile.port === DEFAULT_PORTS[profile.dbType]) {
      patch.port = DEFAULT_PORTS[dbType];
    }
    // SQLiteとそれ以外では「データベース」欄の意味が変わるためクリアする
    if ((dbType === "sqlite") !== (profile.dbType === "sqlite")) {
      patch.database = "";
    }
    set(patch);
  };

  /** SQLiteはファイルを直接開くため、ホスト・ユーザー等の入力を出さない */
  const isSqlite = profile.dbType === "sqlite";
  /** TLSの細かい設定を出すのはMySQL / PostgreSQLだけ (ValkeyはON/OFFのみ) */
  const hasSslMode =
    profile.dbType === "mysql" || profile.dbType === "postgresql";
  const sslMode: SslMode = profile.sslMode ?? "";

  /** 証明書ファイルを選ぶ (キャンセル時は何もしない) */
  const pickCert = async (
    title: string,
    apply: (path: string) => void
  ) => {
    const selected = await open({
      multiple: false,
      title,
      filters: [{ name: "証明書・鍵 (PEM)", extensions: ["pem", "crt", "cer", "key"] }],
    }).catch(() => null);
    if (typeof selected === "string") apply(selected);
  };

  /** 証明書パスの入力欄 (参照ボタンつき) */
  const certField = (
    label: string,
    value: string | undefined,
    apply: (path: string) => void
  ) => (
    <label className="span2">
      <span className="field-label">{label}</span>
      <span className="key-path-row">
        <input
          className="mono"
          value={value ?? ""}
          onChange={(e) => apply(e.target.value)}
        />
        <button
          type="button"
          className="browse-btn"
          title={`${label}を選択`}
          onClick={() => pickCert(`${label}を選択`, apply)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
          参照
        </button>
      </span>
    </label>
  );

  return (
    <div className="form">
      <section className="card">
        <div className="card-head">
          <h2>基本設定</h2>
          <div className="segmented" role="tablist" aria-label="DB種別">
            {/* 互換のあるDBは、どれを選べばよいか分かるよう説明を出す */}
            {(
              [
                ["mysql", "MySQL", "MySQL / MariaDB"],
                ["postgresql", "PostgreSQL", "PostgreSQL (Amazon Aurora等の互換も)"],
                ["sqlite", "SQLite", "SQLite のデータベースファイル"],
                ["valkey", "Valkey", "Valkey / Redis 互換 (ElastiCache等)"],
              ] as [DbType, string, string][]
            ).map(([t, label, tip]) => (
              <button
                key={t}
                className={
                  "segment has-tooltip" +
                  (profile.dbType === t ? " active" : "")
                }
                data-tooltip={tip}
                onClick={() => changeDbType(t)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="form-grid">
          <label className="span2">
            <span className="field-label">接続名</span>
            <input
              value={profile.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="例: 本番DB (読み取り用)"
            />
          </label>
          {isSqlite && (
            <label className="span2">
              <span className="field-label">データベースファイル</span>
              <span className="key-path-row">
                <input
                  className="mono"
                  value={profile.database ?? ""}
                  onChange={(e) => set({ database: e.target.value })}
                  placeholder="/path/to/app.db"
                />
                <button
                  type="button"
                  className="browse-btn"
                  title="SQLiteのデータベースファイルを選択"
                  onClick={async () => {
                    const selected = await open({
                      multiple: false,
                      title: "SQLiteのデータベースファイルを選択",
                      filters: [
                        {
                          name: "SQLite",
                          extensions: ["db", "sqlite", "sqlite3", "db3"],
                        },
                        { name: "すべてのファイル", extensions: ["*"] },
                      ],
                    }).catch(() => null);
                    if (typeof selected === "string") {
                      set({ database: selected });
                    }
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                  </svg>
                  参照
                </button>
              </span>
            </label>
          )}
          {!isSqlite && (
            <>
          <label className="grow">
            <span className="field-label">ホスト</span>
            <input
              className="mono"
              value={profile.host}
              onChange={(e) => set({ host: e.target.value })}
              placeholder="localhost"
            />
          </label>
          <label className="w-port">
            <span className="field-label">ポート</span>
            <input
              className="mono"
              type="number"
              value={profile.port}
              onChange={(e) => set({ port: Number(e.target.value) })}
            />
          </label>
          <label>
            <span className="field-label">
              {profile.dbType === "valkey" ? (
                <>
                  DB番号 (0-15) <em>任意</em>
                </>
              ) : (
                <>
                  データベース名 <em>任意</em>
                </>
              )}
            </span>
            <input
              className="mono"
              value={profile.database ?? ""}
              placeholder={profile.dbType === "valkey" ? "0" : undefined}
              onChange={(e) => set({ database: e.target.value })}
            />
          </label>
          <label>
            <span className="field-label">
              {profile.dbType === "valkey" ? (
                <>
                  ユーザー <em>任意 (ACL)</em>
                </>
              ) : (
                "ユーザー"
              )}
            </span>
            <input
              className="mono"
              value={profile.user}
              onChange={(e) => set({ user: e.target.value })}
            />
          </label>
          <label className="span2">
            <span className="field-label">パスワード</span>
            <input
              type="password"
              value={profile.passwordLocked ? "" : profile.password}
              // 保存済みのものは中身を持ってこないので、そうと分かるようにする
              placeholder={
                profile.passwordSaved && !profile.passwordLocked
                  ? "保存済み (変えるときだけ入力)"
                  : ""
              }
              onChange={(e) => setSecret({ password: e.target.value })}
            />
          </label>
          {profile.passwordLocked && (
            <div className="span2 locked-secret">
              保存されたパスワード (SSHのパスフレーズを含む) を復号できませんでした。
              入力し直して保存してください。
              (OSのキーチェーンが使えないなどで、暗号化に使う鍵が変わった可能性があります)
            </div>
          )}
          {hasSslMode && (
            <>
              {/*
                * SelectMenu はボタンで作った独自の部品なので、
                * <label> では包まない
                * (包むと、項目を押したクリックがラベル経由で
                *  ボタンへ送り直され、閉じた直後にまた開いてしまう)
                */}
              <div className="form-field span2">
                <span className="field-label">TLS (通信の暗号化)</span>
                {/* ネイティブの<select>はドロップダウンがOS描画になり、
                    アプリのテーマと合わないので共通のSelectMenuを使う */}
                <SelectMenu
                  className="select-field"
                  value={sslMode}
                  options={SSL_MODES.map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  onChange={(v) => set({ sslMode: v as SslMode })}
                />
                {/* 「検証しない」を選んでいることに気づけるようにする */}
                {tlsUnverified(sslMode) && (
                  <span className="field-note warn">
                    サーバー証明書を検証しません。通信の相手が本物かを確かめないため、
                    途中で差し替えられても気づけません。
                    {viaTunnel(profile)
                      ? " (この接続はSSH / SSM経由なので、経路そのものは守られます)"
                      : " 社内・クラウドのDBへ直接つなぐ場合は「必須 + CA証明書とホスト名を検証」を選んでください"}
                  </span>
                )}
              </div>
              {sslMode !== "" && sslMode !== "disable" && (
                <>
                  {(sslMode === "verify-ca" || sslMode === "verify-full") &&
                    certField("CA証明書", profile.caCertPath, (caCertPath) =>
                      set({ caCertPath })
                    )}
                  {certField(
                    "クライアント証明書",
                    profile.clientCertPath,
                    (clientCertPath) => set({ clientCertPath })
                  )}
                  {certField(
                    "クライアント秘密鍵",
                    profile.clientKeyPath,
                    (clientKeyPath) => set({ clientKeyPath })
                  )}
                </>
              )}
            </>
          )}
          {profile.dbType === "valkey" && (
            <div className="span2 tls-row">
              <span className="field-label">TLS (in-transit暗号化)</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={profile.tls ?? false}
                  onChange={(e) => set({ tls: e.target.checked })}
                />
                <span className="track" aria-hidden />
                <span className="switch-label">
                  {profile.tls
                    ? "TLSで接続する (AWS ElastiCache等で必要)"
                    : "TLSで接続しない"}
                </span>
              </label>
            </div>
          )}
            </>
          )}
          <div className="span2 tls-row">
            <span className="field-label">環境</span>
            <div className="env-pick">
              {/* 未設定のままでも使えるようにする (今までの接続はここに入る) */}
              <div className="segmented">
                <button
                  className={"segment" + (profile.env ? "" : " active")}
                  onClick={() => set({ env: undefined })}
                >
                  未設定
                </button>
                {ENVS.map(([e, label, color]) => (
                  <button
                    key={e}
                    className={"segment" + (profile.env === e ? " active" : "")}
                    onClick={() => set({ env: e as ConnectionEnv })}
                  >
                    <span className="env-dot" style={{ background: color }} aria-hidden />
                    {label}
                  </button>
                ))}
              </div>
              <span className="field-note">
                {profile.env === "prod"
                  ? "接続するときに確認を出し、定義の変更 (ALTER・RENAME) の確認は設定で外せなくなります"
                  : "タブ・画面下の帯・接続一覧の色が環境に合わせて変わります (色を選ぶとそちらが優先)"}
              </span>
            </div>
          </div>
          <div className="span2 tls-row">
            <span className="field-label">読み取り専用</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={profile.readOnly ?? false}
                onChange={(e) => set({ readOnly: e.target.checked })}
              />
              <span className="track" aria-hidden />
              <span className="switch-label">
                {profile.readOnly
                  ? "更新系の操作をすべて拒否する (本番向け)"
                  : "更新系の操作を許可する (通常)"}
              </span>
            </label>
          </div>
        </div>
      </section>

      {!isSqlite && (
      <section className={"card" + (route === "none" ? " collapsed" : "")}>
        <div className="card-head">
          <h2>接続経路</h2>
          <SelectMenu
            value={route}
            options={ROUTES.map(([value, label]) => ({ value, label }))}
            onChange={(v) => onChange(applyRoute(profile, v as ConnectRoute))}
          />
        </div>

        <ConnectionProxyFields
          route={route}
          proxy={proxy}
          onChange={setProxy}
        />

        {route === "ssh" && (
          <div className="form-grid">
            <label className="grow">
              <span className="field-label">SSHホスト</span>
              <input
                className="mono"
                value={ssh.host}
                onChange={(e) => setSsh({ host: e.target.value })}
                placeholder="bastion.example.com"
              />
            </label>
            <label className="w-port">
              <span className="field-label">ポート</span>
              <input
                className="mono"
                type="number"
                value={ssh.port}
                onChange={(e) => setSsh({ port: Number(e.target.value) })}
              />
            </label>
            <label>
              <span className="field-label">SSHユーザー</span>
              <input
                className="mono"
                value={ssh.user}
                onChange={(e) => setSsh({ user: e.target.value })}
              />
            </label>
            <label>
              <span className="field-label">秘密鍵ファイル</span>
              <span className="key-path-row">
                <input
                  className="mono"
                  value={ssh.keyPath}
                  onChange={(e) => setSsh({ keyPath: e.target.value })}
                  placeholder="~/.ssh/id_ed25519"
                />
                <button
                  type="button"
                  className="browse-btn"
                  title="秘密鍵ファイルを選ぶ"
                  onClick={async () => {
                    // ~/.ssh は不可視フォルダのため、絶対パスに解決して
                    // 初期フォルダに指定する (無ければホームディレクトリ)。
                    // ダイアログはフォルダの中を直接開くので、隠しフォルダでも
                    // 中の鍵ファイルはそのまま選択できる
                    const dir = await defaultSshKeyDir().catch(() => null);
                    const selected = await open({
                      multiple: false,
                      defaultPath: dir ?? undefined,
                      title: "秘密鍵ファイルを選択",
                    }).catch(() => null);
                    if (typeof selected === "string") {
                      setSsh({ keyPath: selected });
                    }
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                  </svg>
                  参照
                </button>
              </span>
            </label>
            <label className="span2">
              <span className="field-label">
                パスフレーズ <em>任意</em>
              </span>
              <input
                type="password"
                value={profile.passwordLocked ? "" : (ssh.passphrase ?? "")}
                placeholder={
                  profile.passphraseSaved && !profile.passwordLocked
                    ? "保存済み (変えるときだけ入力)"
                    : ""
                }
                onChange={(e) => setSshSecret({ passphrase: e.target.value })}
              />
            </label>
          </div>
        )}
      </section>
      )}

      <div className="form-actions">
        <button
          className="btn-primary"
          onClick={onConnect}
          disabled={connecting || saving}
        >
          {connecting ? (
            <>
              <span className="spinner light" /> 接続中...
            </>
          ) : (
            "接続"
          )}
        </button>
        <button
          className="btn-secondary btn-ok"
          onClick={onTest}
          disabled={testing}
        >
          {testing ? (
            <>
              <span className="spinner" /> テスト中...
            </>
          ) : (
            "接続テスト"
          )}
        </button>
        <button
          className="btn-secondary"
          onClick={onSave}
          disabled={saving || connecting}
        >
          {saving ? "保存中..." : "保存"}
        </button>
        {profile.id && (
          <button className="btn-danger" onClick={() => setConfirmDelete(true)}>
            削除
          </button>
        )}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="接続先を削除します"
          target={profile.name || `${profile.host}:${profile.port}`}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await onDelete();
            setConfirmDelete(false);
          }}
        >
          ホスト・ユーザー・パスワード・SSHの設定がまとめて消えます。
          取り消しはできません。
          (設定 &gt; バックアップ で書き出しておくと復元できます)
        </ConfirmDialog>
      )}
    </div>
  );
}
