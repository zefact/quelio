import { useEffect, useState } from "react";
import { useModal } from "../hooks/useModal";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  APP_NAME,
  APP_TAGLINE_LINES,
  COPYRIGHT,
  SITE_LABEL,
  SITE_URL,
  formatDate,
  releaseDateOf,
} from "../appInfo";

/** 外部リンクであることを示すアイコン */
function ExternalIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 4h6v6M20 4l-8.5 8.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface Props {
  onClose: () => void;
}

/**
 * 「Quelioについて」ダイアログ。
 * macOSはメニューバーから、Windows等は︙メニューから開く (どちらも同じ画面)
 */
export function AboutDialog({ onClose }: Props) {
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then((v) => setVersion(v ?? ""))
      .catch(() => {});
  }, []);

  // Escで閉じる・初期フォーカスは共通の作法にそろえる
  const boxRef = useModal<HTMLDivElement>(onClose);

  const isBeta = version.startsWith("0.");
  const released = releaseDateOf(version);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal about-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        {/* アプリのアイコン (public/quelio.svg = ビルドで使うアイコンの元データ) */}
        <img className="about-icon" src="/quelio.svg" width={76} height={76} alt="" />
        <div className="about-name">
          {APP_NAME}
          {isBeta && <span className="beta-badge">β</span>}
        </div>
        <div className="about-desc">
          {APP_TAGLINE_LINES.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>

        <dl className="about-meta">
          <div className="about-meta-row">
            <dt>バージョン</dt>
            <dd className="mono">
              {version ? version : "-"}
              {isBeta && <span className="about-beta-note">ベータ版</span>}
            </dd>
          </div>
          {released && (
            <div className="about-meta-row">
              <dt>リリース日</dt>
              <dd>{formatDate(released)}</dd>
            </div>
          )}
          <div className="about-meta-row">
            <dt>サイト</dt>
            <dd>
              <button
                className="about-link"
                onClick={() => openUrl(SITE_URL).catch(() => {})}
                title={`${SITE_URL} をブラウザで開く`}
              >
                {SITE_LABEL}
                <ExternalIcon />
              </button>
            </dd>
          </div>
        </dl>

        <div className="about-copy">{COPYRIGHT}</div>
        <button className="btn-secondary about-close" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
