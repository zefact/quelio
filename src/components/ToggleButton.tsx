/**
 * 入れる / 切るを切り替えるスイッチ (実行ボタンの並びのトランザクション・キャプチャ)。
 *
 * 見た目はほかのスイッチと同じ丸いつまみの形で、溝の中に名前を書く。
 * 入っているときはつまみが右に寄り、溝に色が付く。
 * 切れているときはつまみが左にあり、溝は灰色。
 * 読み上げには aria-pressed で入っているかどうかを伝える
 */
interface Props {
  /** ボタンに書く名前 (例: トランザクション) */
  label: string;
  /** 入っているか */
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  /** ツールチップ (何が起きるかの説明) */
  tooltip: string;
  /** ツールチップを折り返して広めに出す (説明が長いとき) */
  wrapTip?: boolean;
}

export function ToggleButton({
  label,
  on,
  onChange,
  disabled,
  tooltip,
  wrapTip,
}: Props) {
  return (
    <button
      type="button"
      className={
        "toggle-pill has-tooltip tooltip-left" + (wrapTip ? " tooltip-wrap" : "")
      }
      aria-pressed={on}
      disabled={disabled}
      data-tooltip={tooltip}
      onClick={() => onChange(!on)}
    >
      <span className="toggle-knob" aria-hidden />
      <span className="toggle-text">{label}</span>
    </button>
  );
}
