import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  exportConnections,
  exportErDiagrams,
  importConnections,
  importErDiagrams,
} from "../api";
import { SettingRow } from "./SettingRow";

interface Props {
  notify: (msg: string) => void;
  /** 接続一覧のインポート後に一覧を再読込させる */
  onImported: () => void;
}

/** ファイル名に付ける日付 (YYYYMMDD) */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];

/** 設定 > エクスポート/インポートページ */
export function SettingsBackup({ notify, onImported }: Props) {
  const [busy, setBusy] = useState(false);

  /** エクスポート共通処理: 保存先を選んで書き出す */
  const doExport = async (
    defaultName: string,
    run: (path: string) => Promise<number>,
    label: string
  ) => {
    if (busy) return;
    const path = await save({
      defaultPath: defaultName,
      filters: JSON_FILTER,
      title: `${label}をエクスポート`,
    }).catch(() => null);
    if (!path) return;
    setBusy(true);
    try {
      const count = await run(path);
      notify(`${label}を${count}件エクスポートしました`);
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** インポート共通処理: ファイルを選んで取り込む */
  const doImport = async (
    run: (path: string) => Promise<{ added: number; updated: number }>,
    label: string,
    reloadAfter: boolean
  ) => {
    if (busy) return;
    const path = await open({
      multiple: false,
      filters: JSON_FILTER,
      title: `${label}をインポート`,
    }).catch(() => null);
    if (typeof path !== "string") return;
    setBusy(true);
    try {
      const r = await run(path);
      notify(`${label}を取り込みました (追加${r.added}件 / 上書き${r.updated}件)`);
      if (reloadAfter) onImported();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="set-section">
        <h3 className="set-section-title">接続一覧</h3>
        <SettingRow
          title="接続一覧のエクスポート / インポート"
          desc={
            <>
              保存済みの接続先とフォルダ構成をJSONファイルで書き出し/取り込みします。
              <br />
              セキュリティのため、パスワードとSSHパスフレーズはエクスポートに
              含まれません (インポート後に再入力してください)。
              同じIDの接続先は上書きされます。
            </>
          }
        >
          <div className="set-btn-row">
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                doExport(
                  `quelio_connections_${today()}.json`,
                  exportConnections,
                  "接続一覧"
                )
              }
            >
              エクスポート
            </button>
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() => doImport(importConnections, "接続一覧", true)}
            >
              インポート
            </button>
          </div>
        </SettingRow>
      </section>

      <section className="set-section">
        <h3 className="set-section-title">ER図</h3>
        <SettingRow
          title="ER図のエクスポート / インポート"
          desc={
            <>
              保存済みの全ER図 (配置・注釈・表示設定を含む) をJSONファイルで
              書き出し/取り込みします。同じ名前の図は上書きされます。
            </>
          }
        >
          <div className="set-btn-row">
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                doExport(
                  `quelio_er_diagrams_${today()}.json`,
                  exportErDiagrams,
                  "ER図"
                )
              }
            >
              エクスポート
            </button>
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() => doImport(importErDiagrams, "ER図", false)}
            >
              インポート
            </button>
          </div>
        </SettingRow>
      </section>
    </>
  );
}
