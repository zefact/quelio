import { useEffect, useRef, useState } from "react";
import type { Notify } from "../notify";
import { detectTools, getToolSettings, saveToolSettings } from "../api";
import type { ToolSettings, ToolStatus } from "../types";

interface Props {
  notify: Notify;
}

const TOOL_KEYS: { tool: string; key: keyof ToolSettings; desc: string }[] = [
  { tool: "mysqldump", key: "mysqldump", desc: "MySQLのSQLダンプ出力" },
  { tool: "mysql", key: "mysql", desc: "MySQLのSQLファイル実行" },
  { tool: "pg_dump", key: "pgDump", desc: "PostgreSQLのSQLダンプ出力" },
  { tool: "psql", key: "psql", desc: "PostgreSQLのSQLファイル実行" },
];

/**
 * バージョン文字列からバージョン番号だけを取り出す。
 * 例: "mysqldump  Ver 9.6.0 for macos14 on arm64" → "9.6.0"
 */
function shortVersion(v: string | null | undefined): string {
  if (!v) return "";
  const m = v.match(/\d+(?:\.\d+)+/);
  return m ? m[0] : v.split(/\r?\n/)[0].trim();
}

function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 12a8 8 0 1 1-2.34-5.66"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M20 3v4.5h-4.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 設定 > 外部ツールページ (mysqldump等のパス設定。変更は自動保存) */
export function SettingsTools({ notify }: Props) {
  const [settings, setSettings] = useState<ToolSettings>({
    mysqldump: "",
    mysql: "",
    pgDump: "",
    psql: "",
  });
  const [status, setStatus] = useState<ToolStatus[]>([]);
  const [loading, setLoading] = useState(true);
  /** 最後に保存した内容 (変更がないblurでの保存を省く) */
  const savedRef = useRef<string>("");

  const refresh = async () => {
    setLoading(true);
    try {
      const [s, st] = await Promise.all([getToolSettings(), detectTools()]);
      setSettings(s);
      setStatus(st);
      savedRef.current = JSON.stringify(s);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** パス変更の自動保存 (blur / Enter)。保存後に再検出する */
  const save = async () => {
    if (JSON.stringify(settings) === savedRef.current) return;
    try {
      await saveToolSettings(settings);
      savedRef.current = JSON.stringify(settings);
      setStatus(await detectTools());
    } catch (e) {
      notify(String(e), "error");
    }
  };

  return (
    <section className="set-section">
      <div className="set-section-head">
        <h3 className="set-section-title">コマンドのパス</h3>
        <button
          className={"refresh-btn" + (loading ? " spinning" : "")}
          onClick={refresh}
          disabled={loading}
          title="パスを再検出する"
        >
          <RefreshIcon />
          再検出
        </button>
      </div>
      <p className="set-section-note">
        SQLダンプの出力・実行に使うコマンドの場所です。空欄のままなら
        よく使われる場所から自動で探します。パスの変更は自動で保存されます。
      </p>

      {loading ? (
        <div className="content-placeholder dim-center">
          <span className="spinner accent" /> 検出中...
        </div>
      ) : (
        <div className="tool-list">
          {TOOL_KEYS.map(({ tool, key, desc }) => {
            const st = status.find((s) => s.tool === tool);
            const ver = shortVersion(st?.version);
            const found = Boolean(st?.path);
            return (
              <div className="tool-item" key={tool}>
                <div className="tool-item-head">
                  <span className="tool-name mono">{tool}</span>
                  <span className="tool-role">{desc}</span>
                  {ver && <span className="tool-ver mono">v{ver}</span>}
                  <span className="tool-item-gap" aria-hidden />
                  <span
                    className={"tool-chip " + (found ? "ok" : "ng")}
                    title={st?.version ?? ""}
                  >
                    <span className="dot" aria-hidden />
                    {found ? "検出済み" : "未検出"}
                  </span>
                </div>
                <input
                  className="tool-path mono"
                  placeholder={
                    found
                      ? "自動検出したパスを使います"
                      : "パスを入力してください"
                  }
                  value={settings[key]}
                  onChange={(e) =>
                    setSettings({ ...settings, [key]: e.target.value })
                  }
                  onBlur={save}
                  onKeyDown={(e) => {
                    // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
                <div className={"tool-meta mono" + (found ? "" : " ng")}>
                  {found ? st?.path : "自動検出できませんでした"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
