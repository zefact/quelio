import { ReactElement, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { SettingsBackup } from "./SettingsBackup";
import { SettingsGeneral } from "./SettingsGeneral";
import { SettingsTools } from "./SettingsTools";

interface Props {
  onClose: () => void;
  /** 接続一覧のインポート後に一覧を再読込させる */
  onImported: () => void;
}

type Page = "general" | "tools" | "backup";

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M19.4 13.5a7.6 7.6 0 000-3l2-1.2-2-3.4-2.3 1a7.6 7.6 0 00-2.6-1.5L14.2 3h-4l-.4 2.4a7.6 7.6 0 00-2.6 1.5l-2.3-1-2 3.4 2 1.2a7.6 7.6 0 000 3l-2 1.2 2 3.4 2.3-1a7.6 7.6 0 002.6 1.5l.4 2.4h4l.3-2.4a7.6 7.6 0 002.6-1.5l2.3 1 2-3.4z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ToolIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M7 9.5l3 2.5-3 2.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12.5 15h4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function PortIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M8 3v10m0 0 3-3m-3 3-3-3M16 21V11m0 0 3 3m-3-3-3 3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const NAV: { page: Page; label: string; icon: () => ReactElement }[] = [
  { page: "general", label: "一般", icon: GearIcon },
  { page: "tools", label: "外部ツール", icon: ToolIcon },
  { page: "backup", label: "エクスポート/インポート", icon: PortIcon },
];

/** 設定モーダル (左: ナビゲーション / 右: 設定行) */
export function SettingsModal({ onClose, onImported }: Props) {
  const [page, setPage] = useState<Page>("general");
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then((v) => setVersion(v ?? ""))
      .catch(() => {});
    return () => window.clearTimeout(timer.current);
  }, []);

  /** 保存トーストの表示 (各ページから呼ばれる) */
  const notify = (msg: string) => {
    setToast(msg);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2000);
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal settings-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <aside className="settings-nav">
          <div className="settings-nav-title">設定</div>
          {NAV.map(({ page: p, label, icon: Icon }) => (
            <button
              key={p}
              className={"settings-nav-item" + (page === p ? " active" : "")}
              onClick={() => setPage(p)}
            >
              <Icon />
              {label}
            </button>
          ))}
          <span className="settings-nav-spacer" aria-hidden />
          {version && (
            <div className="settings-nav-version mono">
              Quelio v{version}
              {version.startsWith("0.") && " (β)"}
            </div>
          )}
        </aside>

        <div className="settings-body">
          {page === "general" ? (
            <SettingsGeneral notify={notify} />
          ) : page === "tools" ? (
            <SettingsTools notify={notify} />
          ) : (
            <SettingsBackup notify={notify} onImported={onImported} />
          )}
        </div>

        <button
          className="modal-close settings-close"
          onClick={onClose}
          title="閉じる"
        >
          ×
        </button>
        {toast && <div className="save-toast">{toast}</div>}
      </div>
    </div>
  );
}
