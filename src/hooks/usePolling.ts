import { useEffect, useRef } from "react";

interface Options {
  /**
   * ウィンドウが隠れている間の間隔 (ms)。
   * 省略すると隠れている間は止める。
   * 隠れていても動かし続けたい画面だけ指定する
   */
  hiddenIntervalMs?: number;
  /** falseの間は止める (確認ダイアログを開いている間など) */
  enabled?: boolean;
}

/**
 * 一定間隔で処理を呼ぶ。
 * ウィンドウが隠れている間は止める (または間隔を伸ばす) ので、
 * 別ウィンドウとして開きっぱなしの画面が裏で問い合わせ続けない。
 *
 * 表に戻ったときは、待たずに1回呼んでから再開する
 */
export function usePolling(
  fn: () => void,
  intervalMs: number,
  options: Options = {}
) {
  const { hiddenIntervalMs, enabled = true } = options;
  // 最新の処理を参照する (呼び出し側で毎回関数を作り直しても再登録しない)
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });

  useEffect(() => {
    let timer = 0;
    /** 今動いている間隔 (張り替えの要否を判断する) */
    let current = 0;

    const stop = () => {
      if (timer) window.clearInterval(timer);
      timer = 0;
      current = 0;
    };
    /** 状況に合った間隔で動かす (0なら止める) */
    const run = (ms: number, callNow: boolean) => {
      if (ms === 0) {
        stop();
        return;
      }
      if (timer && current === ms) return;
      stop();
      current = ms;
      if (callNow) latest.current();
      timer = window.setInterval(() => latest.current(), ms);
    };
    const apply = (callNow: boolean) => {
      if (!enabled) stop();
      else if (document.hidden) run(hiddenIntervalMs ?? 0, false);
      else run(intervalMs, callNow);
    };

    apply(true);
    const onVisibility = () => apply(true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, hiddenIntervalMs, enabled]);
}
