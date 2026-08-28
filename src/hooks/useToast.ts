import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 「コピーしました」のような短いメッセージを一時表示する。
 *
 * 連続して呼ばれたときは、前の表示を消してから出し直す
 * (先に出したぶんのタイマーで、後から出した表示が消えないように)。
 * 画面から離れるときはタイマーを片付ける
 *
 * @param ms 表示しておく時間 (ミリ秒)
 */
export function useToast(ms = 2000) {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );

  const flash = useCallback(
    (message: string) => {
      setToast(message);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setToast(null), ms);
    },
    [ms]
  );

  /** 出したままの表示を消す (画面を切り替えたときなど) */
  const clear = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    setToast(null);
  }, []);

  return { toast, flash, clear };
}
