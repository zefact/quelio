import type { Clip } from "../cellValue";

interface Props {
  value: string;
  /** 切り詰められている場合の長さ (切り詰めていなければ null) */
  clip: Clip | null;
  /** 「…」を押したとき (全文表示を開く) */
  onOpen?: (value: string) => void;
}

/**
 * グリッドの1セル。
 * 長すぎて切り詰められた値にはボタンを付け、全文表示を開けるようにする。
 *
 * 表示する文字は切り詰めの注記も含めてそのまま出す
 * (グリッドのコピーはDOMの文字列を読むため、ここを削ると値が変わってしまう)。
 * ボタンの「…」はCSSの擬似要素で描き、コピーに混ざらないようにしている
 */
export function CellText({ value, clip, onOpen }: Props) {
  if (clip === null) {
    return (
      <span className="mono" title={value}>
        {value}
      </span>
    );
  }
  return (
    <span className="mono clipped-cell">
      <span className="clipped-head" title={value}>
        {value}
      </span>
      <button
        className="cell-more"
        title={`全${clip.total.toLocaleString()}文字。押すと全文を表示します`}
        onClick={(e) => {
          e.stopPropagation();
          onOpen?.(value);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      />
    </span>
  );
}
