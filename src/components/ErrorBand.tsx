import { CloseMark } from "./CloseMark";
import { IconButton } from "./IconButton";

interface Props {
  /** 出す文 */
  message: string;
  /** 色 (既定は失敗の赤。中止したときなどは ok) */
  tone?: "ng" | "ok" | "warn";
  /** 置き場所を画面ごとに変えるための class */
  className?: string;
  /** × で閉じる */
  onClose: () => void;
}

/**
 * 窓の上に出すエラーの帯 (ER図・スキーマ一覧・差分の窓)。
 *
 * 次の操作をするまで残すが、読んだら × で閉じられるようにする
 * (閉じられないと、その分だけ図や一覧が狭くなったままになる)
 */
export function ErrorBand({ message, tone = "ng", className, onClose }: Props) {
  return (
    <div
      className={`result-banner ${tone} error-band` + (className ? ` ${className}` : "")}
      role="alert"
    >
      <span className="dot" aria-hidden />
      <span className="result-detail">{message}</span>
      <IconButton className="error-band-close" label="閉じる" onClick={onClose}>
        <CloseMark size={11} />
      </IconButton>
    </div>
  );
}
