import { useEffect, useRef, useState } from "react";

/**
 * 開始時刻からの経過ミリ秒を一定間隔で返す。
 * startedAtがnullのときはマウント時刻を開始とみなす。
 */
export function useElapsed(startedAt: number | null, intervalMs: number) {
  const mountedAt = useRef(Date.now());
  const start = startedAt ?? mountedAt.current;
  const [ms, setMs] = useState(() => Date.now() - start);
  useEffect(() => {
    setMs(Date.now() - start);
    const timer = window.setInterval(() => setMs(Date.now() - start), intervalMs);
    return () => window.clearInterval(timer);
  }, [start, intervalMs]);
  return ms;
}

interface Props {
  /** 計測の開始時刻 (ms)。nullならマウント時刻から数える */
  startedAt: number | null;
  className?: string;
  /** 秒数のうしろに付ける文字列 */
  suffix?: string;
  /** 更新間隔 (ms) */
  intervalMs?: number;
}

/**
 * 経過時間を「1.2s 経過」の形で表示する。
 * タイマーによる再描画をこのコンポーネントの中だけに閉じ込めるのが目的
 * (親に置くと、100msごとに結果グリッドまで作り直しになる)
 */
export function ElapsedTimer({
  startedAt,
  className,
  suffix = "s 経過",
  intervalMs = 100,
}: Props) {
  const ms = useElapsed(startedAt, intervalMs);
  return (
    <span className={className}>
      {(ms / 1000).toFixed(1)}
      {suffix}
    </span>
  );
}
