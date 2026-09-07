/**
 * アプリ全体のメモリ使用量を、少し間を空けて見に行く。
 *
 * 設定で表示をOFFにしている間は、時計も仕掛けない (まったく数えない)。
 * 見えていない窓でも数えない。どの窓から聞いても同じ数字が返るので、
 * 裏に回った窓のぶんまで数え続けると、OSへの問い合わせが窓の数だけ無駄に増える
 */
import { useEffect, useState } from "react";
import { appMemory } from "../api";
import { shouldAsk } from "../memoryPoll";
import type { AppMemory } from "../types";

/** 既定の間隔 (ミリ秒)。数字が動くのを追える程度で、負担にならない間合い */
const EVERY_MS = 3000;

/**
 * @param enabled 表示するか。false の間は一度も数えない
 */
export function useAppMemory(enabled: boolean, everyMs = EVERY_MS): AppMemory | null {
  const [memory, setMemory] = useState<AppMemory | null>(null);

  useEffect(() => {
    if (!enabled) {
      // OFFにした瞬間に古い数字を捨てる (次にONへ戻したとき、前の値が一瞬出ないように)
      setMemory(null);
      return;
    }

    let alive = true;
    /** 前の問い合わせがまだ返っていないか (重ねて投げない) */
    let asking = false;

    const ask = () => {
      if (!shouldAsk({ enabled, hidden: document.hidden, asking })) return;
      asking = true;
      appMemory()
        .then((m) => {
          if (alive) setMemory(m);
        })
        .catch(() => {
          /* 数えられなくても画面は保つ (表示が消えるだけ) */
        })
        .finally(() => {
          asking = false;
        });
    };

    ask();
    const timer = window.setInterval(ask, everyMs);
    // 窓が前に戻ってきたら、待たずに数え直す
    document.addEventListener("visibilitychange", ask);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", ask);
    };
  }, [enabled, everyMs]);

  return memory;
}
