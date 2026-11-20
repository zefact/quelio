import { useEffect, useState } from "react";
import type { Notify } from "../notify";
import { open } from "@tauri-apps/plugin-dialog";
import { pickExportPath } from "../exportDir";
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
  previewCsvLayoutsImport,
  previewErDiagramsImport,
  previewSavedSqlImport,
  quarantineConfigFile,
} from "../api";
import type {
  ConfigFile,
  ConnectionsFileInfo,
  ImportCounts,
  RestorePreview,
} from "../types";
import {
  fileNameOf,
  overwrittenNames,
  restoreCounts,
} from "../restorePreview";
import { SettingRow } from "./SettingRow";
import { RevealButton } from "./RevealButton";
import { ConfirmDialog } from "./ConfirmDialog";
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

  /**
   * 最後に書き出したもの。その欄の下に結果と「フォルダを開く」を出す
   * (次の書き出しか、設定を閉じるまで残す)
   */
  const [exported, setExported] = useState<{
    label: string;
    count: number;
    path: string;
  } | null>(null);

  /** バックアップ共通処理: 書き出し先を選んで書き出す */
  const doExport = async (
    defaultName: string,
    run: (path: string) => Promise<number>,
    label: string
  ) => {
    if (busy) return;
    // ほかの書き出しと同じフォルダから選ぶ
    const path = await pickExportPath({
      fileName: defaultName,
      filters: JSON_FILTER,
      title: `${label}をバックアップ`,
    });
    if (!path) return;
    setBusy(true);
    try {
      const count = await run(path);
      setExported({ label, count, path });
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  /** その欄で書き出した結果 (書き出していなければ何も出さない) */
  const exportedBanner = (label: string) =>
    exported?.label === label ? (
      <div className="result-banner ok set-export-result">
        <span className="dot" aria-hidden />
        <span className="result-detail">
          {label}を{exported.count}件バックアップしました。
        </span>
        <RevealButton path={exported.path} />
      </div>
    ) : null;

  /** 復元するファイルを選ぶ (選ばなければ null) */
  const pickRestoreFile = async (label: string): Promise<string | null> => {
    const path = await open({
      multiple: false,
      filters: JSON_FILTER,
      title: `${label}を復元`,
    }).catch(() => null);
    return typeof path === "string" ? path : null;
  };

  /**
   * 復元する前の確認。
   * 選んだファイルを書き込まずに数えた、追加と上書きの件数と、上書きされるものの名前を出す
   */
  const [askRestore, setAskRestore] = useState<{
    label: string;
    /** 上書きがあるときに添える、何が置き換わるかの説明 */
    note: string;
    path: string;
    preview: RestorePreview;
    /** 「復元する」で取り込む。失敗したら例外を投げる (ダイアログに出す) */
    run: () => Promise<void>;
  } | null>(null);

  /**
   * 復元 (ER図・お気に入り): ファイルを選び、件数を数えてから確認を出す。
   * 中身が無いファイルなら、確認を出さずにそう知らせる
   */
  const startRestore = async (spec: {
    label: string;
    note: string;
    preview: (path: string) => Promise<RestorePreview>;
    run: (path: string) => Promise<ImportCounts>;
  }) => {
    if (busy) return;
    const path = await pickRestoreFile(spec.label);
    if (!path) return;
    setBusy(true);
    try {
      const preview = await spec.preview(path);
      if (preview.added + preview.updated === 0) {
        notify(`選んだファイルに${spec.label}が入っていません`, "warning");
        return;
      }
      setAskRestore({
        label: spec.label,
        note: spec.note,
        path,
        preview,
        run: async () => {
          const r = await spec.run(path);
          notify(
            `${spec.label}を復元しました (追加${r.added}件 / 上書き${r.updated}件)`
          );
        },
      });
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  /** 接続一覧を取り込んだ結果を知らせる */
  const connsImported = (r: ImportCounts) => {
    const secrets = r.secrets > 0 ? ` / パスワード入り${r.secrets}件` : "";
    /*
     * AIへの公開と外部コマンドの場所は、このPCで決めることなので取り込まない。
     * 取り込まなかったものがあれば、設定し直せるように伝える
     */
    const skipped = [
      r.aiKeptLocal > 0 ? `AI連携の公開設定 (${r.aiKeptLocal}件)` : null,
      r.commandPathsDropped > 0
        ? `外部コマンドの場所 (${r.commandPathsDropped}件)`
        : null,
    ].filter((s): s is string => s !== null);
    const done = `接続一覧を復元しました (追加${r.added}件 / 上書き${r.updated}件${secrets})`;
    if (skipped.length === 0) {
      notify(done);
    } else {
      notify(
        `${done}。${skipped.join("・")}はファイルから取り込まず、このPCの設定のままにしました。必要なら接続先の編集で設定し直してください`,
        "warning"
      );
    }
    onImported();
  };

  /**
   * 接続一覧の復元。
   *
   * パスワードが入ったファイルなら、取り込む前にバックアップのパスワードを聞く
   * (件数はそのダイアログに出す)。
   * 入っていなければ、件数を見せる確認を出してから取り込む
   */
  const importConns = async () => {
    if (busy) return;
    const path = await pickRestoreFile("接続一覧");
    if (!path) return;
    setBusy(true);
    try {
      const info = await inspectConnectionsFile(path);
      if (info.hasSecrets) {
        setImportingConns({ path, info });
        return;
      }
      if (info.preview.added + info.preview.updated === 0) {
        notify("選んだファイルに接続先が入っていません", "warning");
        return;
      }
      setAskRestore({
        label: "接続一覧",
        note: "同じ接続先は、ファイルの中身で上書きされます (保存してあるパスワードはそのまま残ります)。",
        path,
        preview: info.preview,
        run: async () => connsImported(await importConnections(path)),
      });
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
              復元では今の接続先は消えません。同じIDの接続先は上書きし、無いものを足します。
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
              復元 (同じものは上書き)
            </button>
          </div>
        </SettingRow>
      </section>

      {askRestore && (
        <ConfirmDialog
          title={`${askRestore.label}を復元します`}
          target={fileNameOf(askRestore.path)}
          confirmLabel="復元する"
          // 上書きはあっても、今あるものを消す操作ではないので赤にしない
          tone="primary"
          onCancel={() => setAskRestore(null)}
          onConfirm={async () => {
            await askRestore.run();
            setAskRestore(null);
          }}
        >
          <div>
            <strong>{restoreCounts(askRestore.preview)}</strong>
          </div>
          {askRestore.preview.updated > 0 && (
            <div>
              上書きされるもの: {overwrittenNames(askRestore.preview.updatedNames)}
            </div>
          )}
          <div>
            {askRestore.preview.updated > 0 && askRestore.note}
            今あるもののうち、ファイルに無いものは消えずに残ります。
          </div>
        </ConfirmDialog>
      )}

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
              onClick={() =>
                void startRestore({
                  label: "ER図",
                  note: "同じ名前のER図は、ファイルの中身で上書きされます (配置・注釈も置き換わります)。",
                  preview: previewErDiagramsImport,
                  run: importErDiagrams,
                })
              }
            >
              復元 (同じものは上書き)
            </button>
          </div>
        </SettingRow>
        {exportedBanner("ER図")}
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
                void startRestore({
                  label: "SQLのお気に入り",
                  note: "同じお気に入りは、ファイルの中身で上書きされます。",
                  preview: previewSavedSqlImport,
                  run: importSavedSql,
                })
              }
            >
              復元 (同じものは上書き)
            </button>
          </div>
        </SettingRow>
        {exportedBanner("SQLのお気に入り")}
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
                void startRestore({
                  label: "固定長のお気に入り",
                  note: "同じ名前のお気に入りは、桁設定がファイルの中身で上書きされます。",
                  preview: previewCsvLayoutsImport,
                  run: importCsvLayouts,
                })
              }
            >
              復元 (同じものは上書き)
            </button>
          </div>
        </SettingRow>
        {exportedBanner("固定長のお気に入り")}
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
              再読み込み
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
