/**
 * 接続経路 (SSH踏み台 / AWS SSM / Cloud SQL Auth Proxy) の入力欄。
 *
 * 経路ごとに要る項目が違うので、ConnectionForm から切り出してある
 */
import { open } from "@tauri-apps/plugin-dialog";
import type { ConnectRoute } from "../connectRoute";
import type { ProxyConfig } from "../types";

interface Props {
  route: ConnectRoute;
  proxy: ProxyConfig;
  onChange: (patch: Partial<ProxyConfig>) => void;
}

/** ファイルを選ぶボタン (鍵ファイル・実行ファイル用) */
function BrowseButton({
  title,
  onPick,
}: {
  title: string;
  onPick: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="browse-btn"
      title={title}
      onClick={async () => {
        const selected = await open({ multiple: false, title }).catch(() => null);
        if (typeof selected === "string") onPick(selected);
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
  );
}

export function ConnectionProxyFields({ route, proxy, onChange }: Props) {
  if (route !== "ssm" && route !== "cloudsql") return null;

  return (
    <div className="form-grid">
      {route === "ssm" ? (
        <>
          <label className="grow">
            <span className="field-label">インスタンスID</span>
            <input
              className="mono"
              value={proxy.target}
              onChange={(e) => onChange({ target: e.target.value })}
              placeholder="i-0123456789abcdef0"
            />
          </label>
          <label>
            <span className="field-label">
              リージョン <em>任意</em>
            </span>
            <input
              className="mono"
              value={proxy.region}
              onChange={(e) => onChange({ region: e.target.value })}
              placeholder="ap-northeast-1"
            />
          </label>
          <label>
            <span className="field-label">
              AWSプロファイル <em>任意</em>
            </span>
            <input
              className="mono"
              value={proxy.profile}
              onChange={(e) => onChange({ profile: e.target.value })}
              placeholder="default"
            />
          </label>
          <p className="route-note span2">
            上の「ホスト」「ポート」へ、このインスタンス経由で転送します。
            AWS CLI と Session Manager プラグインが要ります
          </p>
        </>
      ) : (
        <>
          <label className="span2">
            <span className="field-label">インスタンス接続名</span>
            <input
              className="mono"
              value={proxy.instance}
              onChange={(e) => onChange({ instance: e.target.value })}
              placeholder="my-project:asia-northeast1:main"
            />
          </label>
          <label className="grow">
            <span className="field-label">
              サービスアカウントキー <em>任意</em>
            </span>
            <span className="key-path-row">
              <input
                className="mono"
                value={proxy.credentialsPath}
                onChange={(e) => onChange({ credentialsPath: e.target.value })}
                placeholder="空なら gcloud のログインを使います"
              />
              <BrowseButton
                title="サービスアカウントキー (JSON) を選択"
                onPick={(path) => onChange({ credentialsPath: path })}
              />
            </span>
          </label>
          <div className="span2 tls-row">
            <span className="field-label">IAM認証</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={proxy.autoIam}
                onChange={(e) => onChange({ autoIam: e.target.checked })}
              />
              <span className="track" aria-hidden />
              <span className="switch-label">
                {proxy.autoIam ? "使う (--auto-iam-authn)" : "使わない"}
              </span>
            </label>
          </div>
          <p className="route-note span2">
            接続先はインスタンス接続名で決まるため、上の「ホスト」「ポート」は使いません
          </p>
        </>
      )}

      <label className="span2">
        <span className="field-label">
          実行ファイルのパス <em>任意</em>
        </span>
        <span className="key-path-row">
          <input
            className="mono"
            value={proxy.commandPath}
            onChange={(e) => onChange({ commandPath: e.target.value })}
            placeholder={
              route === "ssm"
                ? "空なら PATH から aws を探します"
                : "空なら PATH から cloud-sql-proxy を探します"
            }
          />
          <BrowseButton
            title="実行ファイルを選択"
            onPick={(path) => onChange({ commandPath: path })}
          />
        </span>
      </label>
    </div>
  );
}
