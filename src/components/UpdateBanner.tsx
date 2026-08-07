import { useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { checkForUpdate, installUpdate } from "../updater";

/**
 * 起動時にアップデートを確認し、あればウィンドウ右上に通知バナーを出す。
 * 「更新して再起動」でダウンロード→インストール→自動再起動する。
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // 起動直後の確認は失敗しても静かに諦める (オフライン等)
    checkForUpdate()
      .then((u) => setUpdate(u))
      .catch(() => {});
  }, []);

  if (!update || dismissed) return null;

  const install = async () => {
    setDownloading(true);
    setError(null);
    try {
      await installUpdate(update, setPercent);
    } catch (e) {
      setDownloading(false);
      setError(`更新に失敗しました: ${e}`);
    }
  };

  return (
    <div className="update-banner">
      <span className="update-banner-text">
        新しいバージョン <strong className="mono">v{update.version}</strong>{" "}
        が利用できます
      </span>
      {error && <span className="update-banner-error">{error}</span>}
      {downloading ? (
        <span className="update-banner-progress mono">
          <span className="spinner accent" />
          {percent === null ? "ダウンロード中..." : `ダウンロード中 ${percent}%`}
        </span>
      ) : (
        <>
          <button className="btn-primary update-banner-btn" onClick={install}>
            更新して再起動
          </button>
          <button
            className="btn-secondary update-banner-btn"
            onClick={() => setDismissed(true)}
          >
            後で
          </button>
        </>
      )}
    </div>
  );
}
