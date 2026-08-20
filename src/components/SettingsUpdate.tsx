import { useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Update } from "@tauri-apps/plugin-updater";
import { checkForUpdate, installUpdate } from "../updater";
import { SettingRow } from "./SettingRow";

type UpdState = "idle" | "checking" | "latest" | "available" | "installing";

/** 設定画面から開く外部リンク */
const LINKS: { label: string; desc: string; url: string }[] = [
  {
    label: "公式サイト",
    desc: "ダウンロードと更新情報",
    url: "https://zefact.github.io/quelio/",
  },
  {
    label: "機能詳細",
    desc: "対応バージョンと、DBごとにできること・できないこと",
    url: "https://zefact.github.io/quelio/support.html",
  },
];

function ExternalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 4h6v6M20 4l-8.5 8.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 設定 > アップデート */
export function SettingsUpdate() {
  const [state, setState] = useState<UpdState>("idle");
  const [version, setVersion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const updateRef = useRef<Update | null>(null);

  const handleCheck = async () => {
    setState("checking");
    setError(null);
    try {
      const u = await checkForUpdate();
      if (u) {
        updateRef.current = u;
        setVersion(u.version);
        setState("available");
      } else {
        setState("latest");
      }
    } catch (e) {
      setState("idle");
      setError(String(e));
    }
  };

  const handleInstall = async () => {
    if (!updateRef.current) return;
    setState("installing");
    setError(null);
    try {
      await installUpdate(updateRef.current, () => {});
    } catch (e) {
      setState("available");
      setError(String(e));
    }
  };

  /** 説明文の下に出す結果 (右側に出すとボタンの位置が動くため) */
  const result = error ? (
    <span className="upd-result ng">{error}</span>
  ) : state === "latest" ? (
    <span className="upd-result ok">お使いのバージョンは最新です</span>
  ) : state === "available" ? (
    <span className="upd-result info">
      新しいバージョン v{version} が利用できます
    </span>
  ) : state === "installing" ? (
    <span className="upd-result info">
      ダウンロードしています。完了すると自動で再起動します
    </span>
  ) : null;

  const busy = state === "checking" || state === "installing";

  return (
    <>
      <section className="set-section">
        <h3 className="set-section-title">アップデート</h3>
        <SettingRow
          title="アップデートの確認"
          desc={
            <>
              新しいバージョンが公開されているか確認します。更新後は自動で再起動します。
              {result && <div className="upd-result-line">{result}</div>}
            </>
          }
        >
          <div className="upd-control">
            {state === "available" || state === "installing" ? (
              <button
                className="btn-primary"
                onClick={handleInstall}
                disabled={busy}
              >
                {busy && <span className="spinner light" />}
                {state === "installing" ? "更新中..." : "更新して再起動"}
              </button>
            ) : (
              <button
                className="btn-secondary"
                onClick={handleCheck}
                disabled={busy}
              >
                {busy && <span className="spinner accent" />}
                {state === "checking" ? "確認中..." : "アップデートを確認"}
              </button>
            )}
          </div>
        </SettingRow>
      </section>

      <section className="set-section">
        <h3 className="set-section-title">リンク</h3>
        {LINKS.map(({ label, desc, url }) => (
          <SettingRow key={url} title={label} desc={desc}>
            <div className="upd-control">
              <button
                className="btn-secondary link-btn"
                onClick={() => openUrl(url).catch(() => {})}
                title={url}
              >
                <ExternalIcon />
                開く
              </button>
            </div>
          </SettingRow>
        ))}
      </section>
    </>
  );
}
