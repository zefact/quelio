import { useState } from "react";
import { SelectMenu } from "../SelectMenu";
import type { CsvOptions, ImportMode } from "../../types";

/** 区切り文字の選択肢 (値はバックエンドへそのまま渡す) */
const DELIMITERS: { value: string; label: string }[] = [
  { value: "", label: "自動判定" },
  { value: ",", label: "カンマ ," },
  { value: "\\t", label: "タブ" },
  { value: ";", label: "セミコロン ;" },
  { value: "|", label: "縦棒 |" },
];

/** 文字コードの選択肢 */
const ENCODINGS: { value: string; label: string }[] = [
  { value: "", label: "自動判定" },
  { value: "utf-8", label: "UTF-8" },
  { value: "shift_jis", label: "Shift_JIS" },
];

/** 取り込み方法の選択肢 */
const MODES: { value: ImportMode; label: string; hint: string }[] = [
  {
    value: "append",
    label: "そのまま追加",
    hint: "既にある行と重複したらエラーにして、何も取り込みません",
  },
  {
    value: "skip",
    label: "重複は飛ばす",
    hint: "キーが既にある行は取り込まず、残りだけ追加します",
  },
  {
    value: "replace",
    label: "重複は上書き",
    hint: "主キーが既にある行を、選んだ列の値で上書きします (主キー以外のキーでの重複はエラーになります)",
  },
];

/** 自動判定の結果を読みやすくする */
function describe(delimiter: string, encoding: string): string {
  const d =
    DELIMITERS.find((x) => x.value === delimiter)?.label ??
    `「${delimiter}」`;
  const e = ENCODINGS.find((x) => x.value === encoding)?.label ?? encoding;
  return `${d} / ${e}`;
}

interface Props {
  options: CsvOptions;
  onOptions: (next: CsvOptions) => void;
  mode: ImportMode;
  onMode: (next: ImportMode) => void;
  emptyAsNull: boolean;
  onEmptyAsNull: (next: boolean) => void;
  /** 実際に使われた区切り文字と文字コード (自動判定の確認用) */
  detected: { delimiter: string; encoding: string } | null;
  /** 実行中は全部触らせない */
  disabled: boolean;
  /** 読み取り方 (区切り文字・文字コード・見出し) だけを触らせない */
  readDisabled: boolean;
}

/**
 * 読み取り方法と取り込み方法の設定 (ファイルを選んでから出す)。
 *
 * 区切り文字と文字コードはたいてい自動判定で足りるので、
 * 判定の結果だけを見せて、変えたいときだけ選択欄を開く。
 * 重複したときの動きは結果が大きく違うので、説明付きのカードで選ばせる
 */
export function CsvSettings({
  options,
  onOptions,
  mode,
  onMode,
  emptyAsNull,
  onEmptyAsNull,
  detected,
  disabled,
  readDisabled,
}: Props) {
  /** 区切り文字・文字コードの選択欄を開いているか (手で選んでいれば開いておく) */
  const [editRead, setEditRead] = useState(
    () => !!options.delimiter || !!options.encoding
  );

  return (
    <div className="csv-settings">
      <div className="csv-read-row">
        {editRead ? (
          <>
            <label className="csv-field">
              <span className="csv-field-label">区切り文字</span>
              <SelectMenu
                className="select-field"
                value={options.delimiter ?? ""}
                options={DELIMITERS}
                disabled={readDisabled}
                onChange={(v) =>
                  onOptions({ ...options, delimiter: v || undefined })
                }
              />
            </label>

            <label className="csv-field">
              <span className="csv-field-label">文字コード</span>
              <SelectMenu
                className="select-field"
                value={options.encoding ?? ""}
                options={ENCODINGS}
                disabled={readDisabled}
                onChange={(v) =>
                  onOptions({ ...options, encoding: v || undefined })
                }
              />
            </label>
          </>
        ) : (
          <span className="csv-read-auto">
            <span className="csv-field-label">区切り文字 / 文字コード</span>
            <span className="csv-read-now">
              自動判定:{" "}
              <span className="mono">
                {detected
                  ? describe(detected.delimiter, detected.encoding)
                  : "読み取り中…"}
              </span>
              <button
                className="tf-link"
                disabled={readDisabled}
                onClick={() => setEditRead(true)}
              >
                変更
              </button>
            </span>
          </span>
        )}

        <label className="switch">
          <input
            type="checkbox"
            checked={options.hasHeader}
            disabled={readDisabled}
            onChange={(e) =>
              onOptions({ ...options, hasHeader: e.target.checked })
            }
          />
          <span className="track" aria-hidden />
          <span className="switch-label">1行目は見出し</span>
        </label>

        <label className="switch">
          <input
            type="checkbox"
            checked={emptyAsNull}
            disabled={disabled}
            onChange={(e) => onEmptyAsNull(e.target.checked)}
          />
          <span className="track" aria-hidden />
          <span className="switch-label">空欄はNULL</span>
        </label>

        {editRead && detected && (
          <span className="csv-settings-hint faint mono">
            読み取り: {describe(detected.delimiter, detected.encoding)}
          </span>
        )}
      </div>

      <div className="csv-mode" role="radiogroup" aria-label="重複したとき">
        <span className="csv-field-label">重複したとき</span>
        <div className="choice-grid cols-3">
          {MODES.map((m) => (
            <label
              key={m.value}
              className={
                "choice-card no-icon" +
                (mode === m.value ? " on" : "") +
                (disabled ? " disabled" : "")
              }
            >
              <input
                type="radio"
                name="csv-import-mode"
                checked={mode === m.value}
                disabled={disabled}
                onChange={() => onMode(m.value)}
              />
              <span className="choice-text">
                <span className="choice-title">{m.label}</span>
                <span className="choice-desc">{m.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
