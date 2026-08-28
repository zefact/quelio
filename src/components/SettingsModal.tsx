import { useEffect, useRef, useState } from "react";
import { useModal } from "../hooks/useModal";
import type { Notify, NotifyLevel } from "../notify";
import { getVersion } from "@tauri-apps/api/app";
import { SettingsBackup } from "./SettingsBackup";
import { SettingsEditor } from "./SettingsEditor";
import { SettingsGeneral } from "./SettingsGeneral";
import { SettingsNav, SettingsPage } from "./SettingsNav";
import { SettingsTools } from "./SettingsTools";
import { SettingsUpdate } from "./SettingsUpdate";

interface Props {
  onClose: () => void;
  /** 接続一覧を復元したあと一覧を再読込させる */
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
  const [toast, setToast] = useState<{ msg: string; level: NotifyLevel } | null>(
    null
  );
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

  // Escで閉じる・初期フォーカスは共通の作法にそろえる
  // (上に確認ダイアログが出ているときは、そちらが先に閉じる)
  const boxRef = useModal<HTMLDivElement>(onClose);

  // ページを切り替えたらスクロール位置は先頭に戻る
  useEffect(() => setScrolled(false), [page]);

  /**
   * 通知の表示 (各ページから呼ばれる)。
   * 成功は2秒で消し、失敗は読み終えるまで残す (押して消す)
   */
  const notify: Notify = (msg, level = "success") => {
    setToast({ msg, level });
    window.clearTimeout(timer.current);
    if (level === "success") {
      timer.current = window.setTimeout(() => setToast(null), 2000);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal settings-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <SettingsNav page={page} onSelect={setPage} version={version} />

        <div className="settings-main">
          <div className={"settings-topbar" + (scrolled ? " scrolled" : "")}>
            {toast && (
              <button
                className={"save-toast " + toast.level}
                title={toast.level === "error" ? "押すと閉じます" : undefined}
                onClick={() => setToast(null)}
              >
                {toast.level === "error" ? "! " : "✓ "}
                {toast.msg}
              </button>
            )}
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
