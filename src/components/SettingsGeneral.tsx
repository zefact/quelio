import { useState } from "react";
import type { Notify } from "../notify";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppSettings } from "../hooks/useAppSettings";
import { ColorMode, getColorMode, setColorMode } from "../theme";
import { SettingRow } from "./SettingRow";

interface Props {
  notify: Notify;
}

const COLOR_MODES: [ColorMode, string][] = [
  ["light", "ライト"],
  ["dark", "ダーク"],
  ["system", "システム"],
];

/** 区切り文字に対応する閉じ括弧 (例の表示用) */
function closing(delim: string): string {
  return { "（": "）", "(": ")", "【": "】", "[": "]" }[delim] ?? "";
}

/** 設定 > 一般 (外観・SQL結果・テーブル構造・保存先) */
export function SettingsGeneral({ notify }: Props) {
  const [mode, setMode] = useState<ColorMode>(getColorMode());
  const { app, setApp, saveApp } = useAppSettings(notify);

  const handleColorMode = (m: ColorMode) => {
    setMode(m);
    setColorMode(m); // 即時反映・保存
  };

  const delim = app.commentDelimiter;

  /** 保存先フォルダをOSのフォルダ選択ダイアログで変更する */
  const handlePickDownloadDir = async () => {
    try {
      const dir = await open({
        directory: true,
        multiple: false,
        defaultPath: app.downloadDir || undefined,
        title: "保存先フォルダを選択",
      });
      if (typeof dir === "string" && dir) {
        saveApp({ ...app, downloadDir: dir });
      }
    } catch (e) {
      notify(String(e), "error");
    }
  };

  return (
    <>
      <section className="set-section">
        <h3 className="set-section-title">外観</h3>
        <SettingRow
          title="カラーモード"
          desc="アプリ全体の配色。「システム」はOSの外観設定に合わせます。"
        >
          <div className="segmented">
            {COLOR_MODES.map(([m, label]) => (
              <button
                key={m}
                className={"segment" + (mode === m ? " active" : "")}
                onClick={() => handleColorMode(m)}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
      </section>

      <section className="set-section">
        <h3 className="set-section-title">起動時</h3>
        <SettingRow
          title="前回のタブを復元する"
          desc="前回開いていたタブ (接続先と書きかけのSQL) を起動時に戻します。接続はしません。切っておくと、空のタブ1つで始まります。"
        >
          <label className="switch">
            <input
              type="checkbox"
              checked={app.restoreTabs}
              onChange={(e) =>
                saveApp({ ...app, restoreTabs: e.target.checked })
              }
            />
            <span className="track" aria-hidden />
          </label>
        </SettingRow>
      </section>

      <section className="set-section">
        <h3 className="set-section-title">SQL結果</h3>
        <SettingRow
          title="行番号を表示"
          desc="SQL実行結果の左端に「行」の列 (取得結果の通し番号) を表示します。"
        >
          <label className="switch">
            <input
              type="checkbox"
              checked={app.showRowNumbers}
              onChange={(e) =>
                saveApp({ ...app, showRowNumbers: e.target.checked })
              }
            />
            <span className="track" aria-hidden />
          </label>
        </SettingRow>
        <SettingRow
          title="定義の変更も確認する"
          desc="ALTER・RENAME の実行前に確認を出します。マイグレーション用のSQLをまとめて流すときは外してください。DROP・TRUNCATE や WHERE の無い UPDATE / DELETE は、この設定に関わらず必ず確認します。"
        >
          <label className="switch">
            <input
              type="checkbox"
              checked={app.confirmAlter}
              onChange={(e) =>
                saveApp({ ...app, confirmAlter: e.target.checked })
              }
            />
            <span className="track" aria-hidden />
          </label>
        </SettingRow>
        <SettingRow
          title="SQL実行のタイムアウト"
          desc="この秒数を超えたSQL実行はエラーで打ち切ります。0にすると無制限です。次の実行から適用されます。"
        >
          <div className="timeout-field">
            <input
              className="delim-input mono"
              type="number"
              min={0}
              max={86400}
              value={app.queryTimeoutSecs}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                setApp({
                  ...app,
                  queryTimeoutSecs: Number.isNaN(n)
                    ? 0
                    : Math.min(Math.max(n, 0), 86400),
                });
              }}
              onBlur={() => saveApp({ ...app })}
              onKeyDown={(e) => {
                // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") saveApp({ ...app });
              }}
            />
            <span>秒</span>
          </div>
        </SettingRow>
      </section>

      <section className="set-section">
        <h3 className="set-section-title">テーブル構造</h3>
        <SettingRow
          title="コメントの表示方法"
          desc="「論理名と補足」ではカラム一覧が論理名/補足の2列に分かれ、テーブル名の横にもテーブルコメントの論理名を表示します。"
        >
          <div className="segmented">
            {(
              [
                ["comment", "コメント表示"],
                ["split", "論理名と補足"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                className={
                  "segment" + (app.structureCommentMode === m ? " active" : "")
                }
                onClick={() => saveApp({ ...app, structureCommentMode: m })}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          title="論理名と補足の区切り文字"
          desc={
            <>
              例: 会社CD{delim || "␣"}YYMMXX{closing(delim)} → 論理名「会社CD」/
              補足「YYMMXX」。スキーマ一覧・CSV出力でも使われます。
              括弧の場合は末尾の閉じ括弧も自動で取り除きます。空欄にすると分解しません。
            </>
          }
        >
          <input
            className="delim-input mono"
            value={delim}
            maxLength={4}
            onChange={(e) =>
              setApp({ ...app, commentDelimiter: e.target.value })
            }
            onBlur={() => saveApp({ ...app, commentDelimiter: delim })}
            onKeyDown={(e) => {
              // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") saveApp({ ...app, commentDelimiter: delim });
            }}
          />
        </SettingRow>
      </section>

      <section className="set-section">
        <h3 className="set-section-title">ファイルの保存先</h3>
        <SettingRow
          stack
          title="保存先フォルダ"
          desc="キャプチャPNG・スキーマCSV・SQLダンプなどの保存先です。未設定の場合はOSのダウンロードフォルダに保存します。"
        >
          <div className="download-dir-field">
            <span
              className="download-dir-path mono"
              title={app.downloadDir || "ダウンロードフォルダ (既定)"}
            >
              {app.downloadDir || "ダウンロードフォルダ (既定)"}
            </span>
            <button className="btn-secondary" onClick={handlePickDownloadDir}>
              変更...
            </button>
            {app.downloadDir && (
              <button
                className="btn-ghost"
                onClick={() => saveApp({ ...app, downloadDir: "" })}
              >
                既定に戻す
              </button>
            )}
          </div>
        </SettingRow>
      </section>
    </>
  );
}
