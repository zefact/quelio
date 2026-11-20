import { CloseMark } from "./CloseMark";
import { useEffect, useRef, useState } from "react";
import { ModalShell } from "./ModalShell";
import type { Notify, NotifyLevel } from "../notify";
import { getVersion } from "@tauri-apps/api/app";
import { SettingsAi } from "./SettingsAi";
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

/** 設定モーダル (左: ナビゲーション / 右: 固定ヘッダ + 設定行) */
export function SettingsModal({ onClose, onImported }: Props) {
  const [page, setPage] = useState<SettingsPage>("general");
  const [toast, setToast] = useState<{
    msg: string;
    level: NotifyLevel;
  } | null>(null);
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

  // ページを切り替えたらスクロール位置は先頭に戻る
  useEffect(() => setScrolled(false), [page]);

  /**
   * 通知の表示 (各ページから呼ばれる)。
   * 成功は2秒で消し、注意と失敗は読み終えるまで残す (押して消す)
   */
  const notify: Notify = (msg, level = "success") => {
    setToast({ msg, level });
    window.clearTimeout(timer.current);
    if (level === "success") {
      timer.current = window.setTimeout(() => setToast(null), 2000);
    }
  };

  return (
    // Escで閉じる・初期フォーカスは共通の作法にそろえる
    // (上に確認ダイアログが出ているときは、そちらが先に閉じる)
    <ModalShell label="設定" onClose={onClose} className="settings-modal">
      <SettingsNav page={page} onSelect={setPage} version={version} />

      <div className="settings-main">
        <div className={"settings-topbar" + (scrolled ? " scrolled" : "")}>
          {toast && (
            <button
              className={"save-toast has-tooltip " + toast.level}
              data-tooltip={toast.level === "success" ? undefined : "押すと閉じます"}
              onClick={() => setToast(null)}
            >
              {toast.level === "success" ? "✓ " : "! "}
              {toast.msg}
            </button>
          )}
          <button
            className="modal-close settings-close has-tooltip"
            onClick={onClose}
            data-tooltip="閉じる (Esc)"
            aria-label="閉じる"
          >
            <CloseMark size={16} />
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
          ) : page === "ai" ? (
            <SettingsAi notify={notify} />
          ) : page === "update" ? (
            <SettingsUpdate />
          ) : (
            <SettingsBackup notify={notify} onImported={onImported} />
          )}
        </div>
      </div>
    </ModalShell>
  );
}
