import type { HeaderLabelMode } from "../types";

/** 選べる出し方と、その説明 */
const ITEMS: [mode: HeaderLabelMode, label: string, tip: string][] = [
  ["name", "英語名", "DBのカラム名だけを出します"],
  [
    "logical",
    "日本語名",
    "カラムコメントの日本語名 (論理名) だけを出します\n" +
      "コメントが無いカラムは英語名のままです",
  ],
  ["both", "両方", "英語名の下に日本語名を並べて出します"],
];

interface Props {
  mode: HeaderLabelMode;
  onChange: (mode: HeaderLabelMode) => void;
}

/**
 * グリッドのヘッダに出す名前の切り替え。
 *
 * 選んだ内容は設定として保存するので、SQL結果とデータタブ、
 * どのタブ・どのウィンドウでも同じ見え方になる
 */
export function HeaderLabelPicker({ mode, onChange }: Props) {
  return (
    <span className="header-label-picker">
      <span className="picker-caption">列名</span>
      <span className="segmented segmented-sm">
        {ITEMS.map(([m, label, tip]) => (
          <button
            key={m}
            className={"segment" + (mode === m ? " active" : "")}
            title={tip}
            onClick={() => onChange(m)}
          >
            {label}
          </button>
        ))}
      </span>
    </span>
  );
}
