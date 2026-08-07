import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { DbIcon } from "./DbIcon";

interface Props {
  onClose: () => void;
}

/**
 * 「Quelioについて」ダイアログ。
 * macOSはネイティブメニューのAboutを使うため、これはWindows等での代替表示。
 */
export function AboutDialog({ onClose }: Props) {
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then((v) => setVersion(v ?? ""))
      .catch(() => {});
  }, []);

  const isBeta = version.startsWith("0.");

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal about-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="about-mark" aria-hidden>
          <DbIcon />
        </span>
        <div className="about-name">
          Quelio
          {isBeta && <span className="beta-badge">β</span>}
        </div>
        {version && (
          <div className="about-version mono">
            Version {version}
            {isBeta && " (ベータ版)"}
          </div>
        )}
        <div className="about-desc">MySQL / PostgreSQL データベースクライアント</div>
        <div className="about-copy">© 2026 ZEFACT</div>
        <button className="btn-secondary about-close" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
