import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AboutDialog } from "./AboutDialog";
import { useDismiss } from "../hooks/useDismiss";
import { IconButton } from "./IconButton";
import { MOD } from "../keyLabel";

interface Props {
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onOpenShortcuts: () => void;
}

/**
 * Windows等 (macOS以外) 用のアプリメニュー (︙ボタン)。
 * macOSはネイティブのメニューバーがあるため表示しない。
 * 中身は macOS のメニューバーに合わせる (設定・ヘルプ・ショートカット・について・終了)
 */
export function AppMenu({ onOpenSettings, onOpenHelp, onOpenShortcuts }: Props) {
  const [open, setOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);

  // 画面のどこかをクリックしたらメニューを閉じる
  useDismiss(open, () => setOpen(false));

  const quit = () => {
    getCurrentWindow()
      .close()
      .catch(() => {});
  };

  return (
    <div className="app-menu">
      <IconButton
        className="console-btn"
        label="メニュー"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="5" r="1.8" fill="currentColor" />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          <circle cx="12" cy="19" r="1.8" fill="currentColor" />
        </svg>
      </IconButton>

      {open && (
        <div
          className="context-menu app-menu-dropdown"
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="context-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            設定…
            <span className="context-hint">{MOD},</span>
          </button>
          <div className="context-sep" aria-hidden />
          <button
            className="context-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenHelp();
            }}
          >
            ヘルプ
          </button>
          <button
            className="context-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenShortcuts();
            }}
          >
            キーボードショートカット
            <span className="context-hint">{MOD}/</span>
          </button>
          <div className="context-sep" aria-hidden />
          <button
            role="menuitem"
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
            role="menuitem"
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
