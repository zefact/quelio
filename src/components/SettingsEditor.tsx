import { useAppSettings } from "../hooks/useAppSettings";
import type { Notify } from "../notify";
import { isMac } from "../platform";
import { SettingRow } from "./SettingRow";
import { SettingsSqlFormat } from "./SettingsSqlFormat";

interface Props {
  notify: Notify;
}

/**
 * 入力補完の操作キー (設定画面に出す一覧)。
 * 候補を出すキーは、macOSは⌃SpaceがIME切り替えに取られるため⌥Space、
 * WindowsやLinuxは一般的なCtrl+Spaceを案内する
 */
const KEY_HINTS: [string[], string][] = [
  [isMac ? ["⌥", "Space"] : ["Ctrl", "Space"], "候補を出す"],
  [["Tab"], "確定"],
  [["Enter"], "確定"],
  [["↑", "↓"], "選ぶ"],
  [["Esc"], "閉じる"],
];

/** 設定 > エディタ (入力補完とSQLの整形) */
export function SettingsEditor({ notify }: Props) {
  const { app, setApp, saveApp } = useAppSettings(notify);

  return (
    <>
    <section className="set-section">
      <h3 className="set-section-title">入力補完</h3>
      <p className="set-section-note">
        SQLエディタで、書いている場所に合わせてテーブル名・カラム名の候補を出します。
      </p>
      <SettingRow
        title="入力補完を使う"
        desc="FROM や JOIN の後ではテーブル名、テーブルが決まっている場所ではカラム名を候補にします。"
      >
        <label className="switch">
          <input
            type="checkbox"
            checked={app.autocompleteEnabled}
            onChange={(e) =>
              saveApp({ ...app, autocompleteEnabled: e.target.checked })
            }
          />
          <span className="track" aria-hidden />
        </label>
      </SettingRow>
      <SettingRow
        title="自動表示までの待ち時間"
        desc="入力が止まってから候補を出すまでの時間です。0にすると自動では表示せず、ショートカットのときだけ出します。"
      >
        <div className="timeout-field">
          <input
            className="delim-input mono"
            type="number"
            min={0}
            max={5000}
            step={50}
            disabled={!app.autocompleteEnabled}
            value={app.autocompleteDelayMs}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              setApp({
                ...app,
                autocompleteDelayMs: Number.isNaN(n)
                  ? 0
                  : Math.min(Math.max(n, 0), 5000),
              });
            }}
            onBlur={() => saveApp({ ...app })}
            onKeyDown={(e) => {
              // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") saveApp({ ...app });
            }}
          />
          <span>ミリ秒</span>
        </div>
      </SettingRow>
      <SettingRow
        title="ショートカット"
        desc="待ち時間が0でも、このキーで候補を出せます。"
      >
        <div className="key-hints">
          {KEY_HINTS.map(([keys, label]) => (
            <div className="key-hint" key={label}>
              <span className="key-hint-keys">
                {keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </span>
              <span className="key-hint-label">{label}</span>
            </div>
          ))}
        </div>
      </SettingRow>
    </section>
    <SettingsSqlFormat app={app} saveApp={saveApp} />
    </>
  );
}
