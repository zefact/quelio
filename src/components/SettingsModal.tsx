import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { SettingsBackup } from "./SettingsBackup";
import { SettingsEditor } from "./SettingsEditor";
import { SettingsGeneral } from "./SettingsGeneral";
import { SettingsNav, SettingsPage } from "./SettingsNav";
import { SettingsTools } from "./SettingsTools";
import { SettingsUpdate } from "./SettingsUpdate";

interface Props {
  onClose: () => void;
  /** 接続一覧のインポート後に一覧を再読込させる */
  onImported: () => void;
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 設定モーダル (左: ナビゲーション / 右: 固定ヘッダ + 設定行) */
export function SettingsModal({ onClose, onImported }: Props) {
  const [page, setPage] = useState<SettingsPage>("general");
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [version, setVersion] = useState("");
  /** 本文をスクロールしたか (ヘッダに区切り線を出すため) */
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    getVersion()
      .then((v) => setVersion(v ?? ""))
      .catch(() => {});
    return () => window.clearTimeout(timer.current);
  }, []);

  // Escでも閉じられるようにする (☓を探さなくて済むように)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ページを切り替えたらスクロール位置は先頭に戻る
  useEffect(() => setScrolled(false), [page]);

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
        <SettingsNav page={page} onSelect={setPage} version={version} />

        <div className="settings-main">
          <div className={"settings-topbar" + (scrolled ? " scrolled" : "")}>
            {toast && <div className="save-toast">{toast}</div>}
            <button
              className="modal-close settings-close"
              onClick={onClose}
              title="閉じる (Esc)"
            >
              <CloseIcon />
            </button>
          </div>

          <div
            className="settings-body"
            key={page}
            onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}
          >
            {page === "general" ? (
              <SettingsGeneral notify={notify} />
            ) : page === "editor" ? (
              <SettingsEditor notify={notify} />
            ) : page === "tools" ? (
              <SettingsTools notify={notify} />
            ) : page === "update" ? (
              <SettingsUpdate />
            ) : (
              <SettingsBackup notify={notify} onImported={onImported} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
