/**
 * 中身は毎回の描画で最新になるが、関数そのものは同じものを返す。
 *
 * 子に React.memo をかけても、描画のたびに新しい関数を渡していては
 * 「前と違うprops」と見なされて素通りになる。
 * かといって useCallback の依存に状態を並べると、
 * 結局その状態が変わるたびに作り直しになる。
 *
 * ここでは呼び出しを常に最新の関数へ転送するので、
 * 渡す側は同一性を、呼ばれる側は最新の状態を、それぞれ保てる。
 * イベントハンドラ専用 (描画中に呼ぶ用途には使わないこと)
 */
import { useMemo, useRef } from "react";

export function useEvent<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  const ref = useRef(fn);
  // 描画のたびに最新へ差し替える (イベントは描画の後に起きる)
  ref.current = fn;
  return useMemo(
    () =>
      (...args: A) =>
        ref.current(...args),
    []
  );
}
