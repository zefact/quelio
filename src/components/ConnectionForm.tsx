import { open } from "@tauri-apps/plugin-dialog";
import { defaultSshKeyDir } from "../api";
import type { ConnectionProfile, DbType, SshConfig } from "../types";
import { DEFAULT_PORTS, emptySsh } from "../types";

interface Props {
  profile: ConnectionProfile;
  onChange: (profile: ConnectionProfile) => void;
  onSave: () => void;
  onDelete: () => void;
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

  const set = (patch: Partial<ConnectionProfile>) =>
    onChange({ ...profile, ...patch });
  const setSsh = (patch: Partial<SshConfig>) =>
    onChange({ ...profile, ssh: { ...ssh, ...patch } });

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

  return (
    <div className="form">
      <section className="card">
        <div className="card-head">
          <h2>基本設定</h2>
          <div className="segmented" role="tablist" aria-label="DB種別">
            {(
              [
                ["mysql", "MySQL"],
                ["postgresql", "PostgreSQL"],
                ["sqlite", "SQLite"],
                ["valkey", "Valkey"],
              ] as [DbType, string][]
            ).map(([t, label]) => (
              <button
                key={t}
                className={"segment" + (profile.dbType === t ? " active" : "")}
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
              value={profile.password}
              onChange={(e) => set({ password: e.target.value })}
            />
          </label>
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
        </div>
      </section>

      {!isSqlite && (
      <section className={"card" + (ssh.enabled ? "" : " collapsed")}>
        <div className="card-head">
          <h2>SSH踏み台</h2>
          <label className="switch">
            <input
              type="checkbox"
              checked={ssh.enabled}
              onChange={(e) => setSsh({ enabled: e.target.checked })}
            />
            <span className="track" aria-hidden />
            <span className="switch-label">
              {ssh.enabled ? "経由する" : "経由しない"}
            </span>
          </label>
        </div>

        {ssh.enabled && (
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
                  title="Finderで秘密鍵ファイルを選択"
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
                value={ssh.passphrase ?? ""}
                onChange={(e) => setSsh({ passphrase: e.target.value })}
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
        <button className="btn-test" onClick={onTest} disabled={testing}>
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
          <button className="btn-danger" onClick={onDelete}>
            削除
          </button>
        )}
      </div>
    </div>
  );
}
