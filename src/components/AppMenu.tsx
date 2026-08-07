import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AboutDialog } from "./AboutDialog";

/**
 * Windows等 (macOS以外) 用のアプリメニュー (︙ボタン)。
 * macOSはネイティブのメニューバーがあるため表示しない。
 */
export function AppMenu() {
  const [open, setOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);

  // 画面のどこかをクリックしたらメニューを閉じる
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const quit = () => {
    getCurrentWindow()
      .close()
      .catch(() => {});
  };

  return (
    <div className="app-menu">
      <button
        className="console-btn has-tooltip"
        data-tooltip="メニュー"
        onClick={() => setOpen((o) => !o)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="5" r="1.8" fill="currentColor" />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          <circle cx="12" cy="19" r="1.8" fill="currentColor" />
        </svg>
      </button>

      {open && (
        <div
          className="context-menu app-menu-dropdown"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="context-item"
            onClick={() => {
              setOpen(false);
              setShowAbout(true);
            }}
          >
            Quelioについて
          </button>
          <div className="context-sep" aria-hidden />
          <button
            className="context-item"
            onClick={() => {
              setOpen(false);
              quit();
            }}
          >
            Quelioを終了
          </button>
        </div>
      )}

      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
    </div>
  );
}
