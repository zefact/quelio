import { useEffect, useState } from "react";
import type { Notify } from "../notify";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  checkConfigFiles,
  exportConnections,
  exportErDiagrams,
  importConnections,
  importErDiagrams,
  quarantineConfigFile,
} from "../api";
import type { ConfigFile } from "../types";
import { SettingRow } from "./SettingRow";

interface Props {
  notify: Notify;
  /** 接続一覧を復元したあと一覧を再読込させる */
  onImported: () => void;
}

/** ファイル名に付ける日付 (YYYYMMDD) */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];

/** 設定 > バックアップページ (接続一覧・ER図の保存と復元) */
export function SettingsBackup({ notify, onImported }: Props) {
  const [busy, setBusy] = useState(false);
  /** 設定ファイルの状態 (未取得はnull) */
  const [files, setFiles] = useState<ConfigFile[] | null>(null);

  const reloadFiles = () => {
    checkConfigFiles()
      .then(setFiles)
      .catch(() => setFiles([]));
  };

  useEffect(reloadFiles, []);

  const broken = (files ?? []).filter((f) => f.error);

  /** 壊れたファイルを退避して作り直せるようにする */
  const doQuarantine = async (f: ConfigFile) => {
    if (busy) return;
    setBusy(true);
    try {
      const moved = await quarantineConfigFile(f.name);
      notify(`${f.label}のファイルを ${moved} へ移しました`);
      reloadFiles();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  /** バックアップ共通処理: 保存先を選んで書き出す */
  const doExport = async (
    defaultName: string,
    run: (path: string) => Promise<number>,
    label: string
  ) => {
    if (busy) return;
    const path = await save({
      defaultPath: defaultName,
      filters: JSON_FILTER,
      title: `${label}をバックアップ`,
    }).catch(() => null);
    if (!path) return;
    setBusy(true);
    try {
      const count = await run(path);
      notify(`${label}を${count}件バックアップしました`);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  /** 復元の共通処理: ファイルを選んで取り込む */
  const doImport = async (
    run: (path: string) => Promise<{ added: number; updated: number }>,
    label: string,
    reloadAfter: boolean
  ) => {
    if (busy) return;
    const path = await open({
      multiple: false,
      filters: JSON_FILTER,
      title: `${label}を復元`,
    }).catch(() => null);
    if (typeof path !== "string") return;
    setBusy(true);
    try {
      const r = await run(path);
      notify(`${label}を取り込みました (追加${r.added}件 / 上書き${r.updated}件)`);
      if (reloadAfter) onImported();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="set-section">
        <h3 className="set-section-title">接続一覧</h3>
        <SettingRow
          title="接続一覧のバックアップ / 復元"
          desc={
            <>
              保存済みの接続先とフォルダ構成をJSONファイルへ書き出し、
              別のPCや再インストール後に読み込めます。
              <br />
              セキュリティのため、パスワードとSSHパスフレーズは書き出しに
              含まれません (復元後に再入力してください)。
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
              バックアップ
            </button>
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() => doImport(importConnections, "接続一覧", true)}
            >
              復元
            </button>
          </div>
        </SettingRow>
      </section>

      <section className="set-section">
        <h3 className="set-section-title">ER図</h3>
        <SettingRow
          title="ER図のバックアップ / 復元"
          desc={
            <>
              保存済みの全ER図 (配置・注釈・表示設定を含む) をJSONファイルへ
              書き出し、あとで読み込めます。同じ名前の図は上書きされます。
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
              バックアップ
            </button>
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() => doImport(importErDiagrams, "ER図", false)}
            >
              復元
            </button>
          </div>
        </SettingRow>
      </section>

      <section className="set-section">
        <h3 className="set-section-title">設定ファイル</h3>
        <SettingRow
          title="設定ファイルの状態"
          desc={
            <>
              設定フォルダのファイルが読める形かを確かめます。壊れていると
              その機能だけが使えなくなり、原因が分かりにくくなります。
              <br />
              「退避」を押すと、消さずに <code>名前.broken-日時</code>{" "}
              へ移して作り直せる状態にします (中身は後から救い出せます)。
              読める状態のファイルは退避できません。
            </>
          }
        >
          <div className="set-btn-row">
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={reloadFiles}
            >
              調べ直す
            </button>
          </div>
        </SettingRow>

        {files === null ? (
          <p className="set-section-note">確認しています…</p>
        ) : broken.length === 0 ? (
          <p className="set-section-note">
            すべて読める状態です ({files.filter((f) => f.exists).length}件)
          </p>
        ) : (
          <ul className="config-file-list">
            {broken.map((f) => (
              <li key={f.name}>
                <div className="config-file-text">
                  <div className="config-file-name">{f.label}</div>
                  <div className="config-file-path mono">{f.path}</div>
                  <div className="config-file-err">{f.error}</div>
                </div>
                <button
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => doQuarantine(f)}
                >
                  退避
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
