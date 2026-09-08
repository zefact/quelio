/**
 * 閉じる印 (✕)。
 *
 * 「×」の字で描くと、書体によって上下の位置が変わる
 * (日本語の書体の × は全角の升目に合わせて描かれていて、
 * 英字の並びの真ん中には来ない)。
 * どの書体でも真ん中に見えるよう、絵で描く
 */
interface Props {
  /** 大きさ (省略すると11px) */
  size?: number;
}

export function CloseMark({ size = 11 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
