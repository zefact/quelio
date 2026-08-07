import { open } from "@tauri-apps/plugin-dialog";
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
    set(patch);
  };

  return (
    <div className="form">
      <section className="card">
        <div className="card-head">
          <h2>基本設定</h2>
          <div className="segmented" role="tablist" aria-label="DB種別">
            {(["mysql", "postgresql"] as DbType[]).map((t) => (
              <button
                key={t}
                className={"segment" + (profile.dbType === t ? " active" : "")}
                onClick={() => changeDbType(t)}
              >
                {t === "mysql" ? "MySQL" : "PostgreSQL"}
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
              データベース名 <em>任意</em>
            </span>
            <input
              className="mono"
              value={profile.database ?? ""}
              onChange={(e) => set({ database: e.target.value })}
            />
          </label>
          <label>
            <span className="field-label">ユーザー</span>
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
        </div>
      </section>

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
                    // ~/.ssh は不可視フォルダのためデフォルトの開始場所に指定する
                    const selected = await open({
                      multiple: false,
                      defaultPath: "~/.ssh",
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
