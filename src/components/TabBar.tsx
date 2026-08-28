import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { emitAppEvent, FIND_EVENT } from "../appEvents";
import { dotStyle } from "../colors";
import type { WorkTab } from "../types";
import { AppMenu } from "./AppMenu";
import { DbIcon } from "./DbIcon";

interface Props {
  tabs: WorkTab[];
  activeKey: string;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onAdd: () => void;
  onOpenConsole: () => void;
  onOpenDiff: () => void;
  onOpenSettings: () => void;
}

/** アプリバージョン (0.x系ならβ扱い) */
function useAppVersion(): string {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion()
      .then((v) => setVersion(v ?? ""))
      .catch(() => {});
  }, []);
  return version;
}

export function TabBar({
  tabs,
  activeKey,
  onActivate,
  onClose,
  onAdd,
  onOpenConsole,
  onOpenDiff,
  onOpenSettings,
}: Props) {
  const version = useAppVersion();
  const isBeta = version.startsWith("0.");
  /**
   * スキーマ差分は接続中のセッションから選ぶため、
   * どこにも接続していないときは押せないようにする
   * (Valkeyはスキーマの概念が無いので対象外)
   */
  const canDiff = tabs.some(
    (t) => t.connected && t.profile.dbType !== "valkey"
  );
  // macOSはネイティブメニューバーがあるため︙メニューは出さない
  const isMac = document.documentElement.classList.contains("macos");
  return (
    <div className="tabbar" data-tauri-drag-region>
      <div className="brand" title="Quelio" data-tauri-drag-region>
        <span className="brand-mark">
          <DbIcon />
        </span>
        <span className="brand-name">Quelio</span>
        {isBeta && <span className="beta-badge">β</span>}
      </div>

      <div className="tabbar-tabs">
        {tabs.map((t) => (
          <div
            key={t.key}
            className={"tab" + (activeKey === t.key ? " active" : "")}
            onClick={() => onActivate(t.key)}
            role="tab"
            aria-selected={activeKey === t.key}
          >
            {t.connected ? (
              <span
                className={`tab-dot ${t.profile.dbType}`}
                style={dotStyle(t.profile.color)}
                aria-hidden
              />
            ) : (
              <span className="tab-dot idle" aria-hidden />
            )}
            <span className="tab-label">
              {t.connected ? t.profile.name || "(無名)" : "新しい接続"}
            </span>
            {t.connected && t.profile.readOnly && (
              <span
                className="ro-badge"
                title="読み取り専用の接続です (更新はできません)"
              >
                R/O
              </span>
            )}
            <button
              className="tab-close"
              title={t.connected ? "切断して閉じる" : "閉じる"}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.key);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <button className="tab-add" title="新しいタブ" onClick={onAdd}>
        +
      </button>

      <span className="tabbar-spacer" data-tauri-drag-region />

      <button
        className="console-btn has-tooltip"
        data-tooltip="画面内を検索 (⌘F)"
        onClick={() => emitAppEvent(FIND_EVENT)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle
            cx="11"
            cy="11"
            r="6"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <path
            d="M20 20l-4.5-4.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </button>

      <button
        className="console-btn has-tooltip"
        data-tooltip={
          canDiff
            ? "スキーマ差分 (2つのDBを比較)"
            : "スキーマ差分 — DBに接続すると使えます"
        }
        onClick={onOpenDiff}
        disabled={!canDiff}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M8 7h12m0 0l-3.5-3.5M20 7l-3.5 3.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M16 17H4m0 0l3.5-3.5M4 17l3.5 3.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <button
        className="console-btn has-tooltip"
        data-tooltip="コンソール (実行SQLの履歴)"
        onClick={onOpenConsole}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
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
          <path
            d="M12.5 15h4.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </button>

      <button
        className="console-btn has-tooltip"
        data-tooltip="設定"
        onClick={onOpenSettings}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M19.4 13.5a7.6 7.6 0 000-3l2-1.2-2-3.4-2.3 1a7.6 7.6 0 00-2.6-1.5L14.2 3h-4l-.4 2.4a7.6 7.6 0 00-2.6 1.5l-2.3-1-2 3.4 2 1.2a7.6 7.6 0 000 3l-2 1.2 2 3.4 2.3-1a7.6 7.6 0 002.6 1.5l.4 2.4h4l.3-2.4a7.6 7.6 0 002.6-1.5l2.3 1 2-3.4z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {!isMac && <AppMenu />}
    </div>
  );
}
