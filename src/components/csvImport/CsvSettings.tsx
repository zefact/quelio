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

/** 読み取り方法と取り込み方法の設定 */
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
  const modeHint = MODES.find((m) => m.value === mode)?.hint ?? "";

  return (
    <div className="csv-settings">
      <label className="csv-field">
        <span className="csv-field-label">区切り文字</span>
        <select
          value={options.delimiter ?? ""}
          disabled={readDisabled}
          onChange={(e) =>
            onOptions({ ...options, delimiter: e.target.value || undefined })
          }
        >
          {DELIMITERS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </label>

      <label className="csv-field">
        <span className="csv-field-label">文字コード</span>
        <select
          value={options.encoding ?? ""}
          disabled={readDisabled}
          onChange={(e) =>
            onOptions({ ...options, encoding: e.target.value || undefined })
          }
        >
          {ENCODINGS.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </select>
      </label>

      <label className="csv-field">
        <span className="csv-field-label">重複したとき</span>
        <select
          value={mode}
          disabled={disabled}
          onChange={(e) =>
            onMode(
              MODES.find((m) => m.value === e.target.value)?.value ?? mode
            )
          }
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

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

      <p className="csv-settings-hint">
        {modeHint}
        {detected && (
          <span className="faint mono">
            {" "}
            / 読み取り: {describe(detected.delimiter, detected.encoding)}
          </span>
        )}
      </p>
    </div>
  );
}
