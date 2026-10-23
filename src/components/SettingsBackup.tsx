import { useEffect, useState } from "react";
import type { Notify } from "../notify";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  checkConfigFiles,
  exportCsvLayouts,
  exportErDiagrams,
  exportSavedSql,
  importConnections,
  importCsvLayouts,
  inspectConnectionsFile,
  importErDiagrams,
  importSavedSql,
  quarantineConfigFile,
} from "../api";
import type { ConfigFile, ConnectionsFileInfo, ImportCounts } from "../types";
import { SettingRow } from "./SettingRow";
import { ConnectionExportDialog } from "./backup/ConnectionExportDialog";
import { ConnectionImportDialog } from "./backup/ConnectionImportDialog";

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
  /** 接続一覧のバックアップの画面を出しているか */
  const [exportingConns, setExportingConns] = useState(false);
  /** パスワード入りの接続一覧を復元しようとしているファイル */
  const [importingConns, setImportingConns] = useState<{
    path: string;
    info: ConnectionsFileInfo;
  } | null>(null);

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
    run: (path: string) => Promise<ImportCounts>,
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

  /** 接続一覧を取り込んだ結果を知らせる */
  const connsImported = (r: ImportCounts) => {
    const secrets = r.secrets > 0 ? ` / パスワード入り${r.secrets}件` : "";
    notify(
      `接続一覧を取り込みました (追加${r.added}件 / 上書き${r.updated}件${secrets})`
    );
    onImported();
  };

  /**
   * 接続一覧の復元。
   *
   * パスワードが入ったファイルなら、取り込む前にバックアップのパスワードを聞く
   */
  const importConns = async () => {
    if (busy) return;
    const path = await open({
      multiple: false,
      filters: JSON_FILTER,
      title: "接続一覧を復元",
    }).catch(() => null);
    if (typeof path !== "string") return;
    setBusy(true);
    try {
      const info = await inspectConnectionsFile(path);
      if (info.hasSecrets) {
        setImportingConns({ path, info });
        return;
      }
      connsImported(await importConnections(path));
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
              パスワードとSSHのパスフレーズは、選んだときだけ含めます
              (含めるときは、決めたパスワードで暗号化します。復元のときにそのパスワードを入れます)。
              同じIDの接続先は上書きされます。
            </>
          }
        >
          <div className="set-btn-row">
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() => setExportingConns(true)}
            >
              バックアップ
            </button>
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() => void importConns()}
            >
              復元
            </button>
          </div>
        </SettingRow>
      </section>

      {exportingConns && (
        <ConnectionExportDialog
          defaultName={`quelio_connections_${today()}.json`}
          onDone={(message) => {
            setExportingConns(false);
            notify(message);
          }}
          onClose={() => setExportingConns(false)}
        />
      )}
      {importingConns && (
        <ConnectionImportDialog
          path={importingConns.path}
          info={importingConns.info}
          onDone={(r) => {
            setImportingConns(null);
            connsImported(r);
          }}
          onClose={() => setImportingConns(null)}
        />
      )}

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
        <h3 className="set-section-title">SQLのお気に入り</h3>
        <SettingRow
          title="SQLのお気に入りのバックアップ / 復元"
          desc={
            <>
              保存したSQLを、フォルダ分けと並び順ごとJSONファイルへ書き出し、
              あとで読み込めます。
              <br />
              復元では今のお気に入りは消えません。
              同じものは上書きし、無いものを足します。
            </>
          }
        >
          <div className="set-btn-row">
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                doExport(
                  `quelio_saved_sql_${today()}.json`,
                  exportSavedSql,
                  "SQLのお気に入り"
                )
              }
            >
              バックアップ
            </button>
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                doImport(importSavedSql, "SQLのお気に入り", false)
              }
            >
              復元
            </button>
          </div>
        </SettingRow>
      </section>

      <section className="set-section">
        <h3 className="set-section-title">固定長のお気に入り</h3>
        <SettingRow
          title="固定長のお気に入りのバックアップ / 復元"
          desc={
            <>
              CSVエディタで登録した固定長の桁設定を、フォルダ分けと並び順ごと
              JSONファイルへ書き出し、あとで読み込めます。
              <br />
              復元では今のお気に入りは消えません。
              同じ名前のものは桁設定を上書きし、無いものを足します
              (入っていたフォルダが無ければ作ります)。
              <br />
              CSVエディタを開いたまま復元したときは、開き直すと一覧に出ます。
            </>
          }
        >
          <div className="set-btn-row">
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                doExport(
                  `quelio_csv_layouts_${today()}.json`,
                  exportCsvLayouts,
                  "固定長のお気に入り"
                )
              }
            >
              バックアップ
            </button>
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                doImport(importCsvLayouts, "固定長のお気に入り", false)
              }
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
