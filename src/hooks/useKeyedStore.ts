import { useCallback, useSyncExternalStore } from "react";
import type { KeyedStore } from "../keyedStore";

/**
 * 画面の外に置いた状態 (`keyedStore`) を読む。
 * キーが変われば、そのキーの状態に切り替わる
 */
export function useKeyedStore<T extends object>(
  store: KeyedStore<T>,
  key: string
): T {
  const subscribe = useCallback(
    (fn: () => void) => store.subscribe(key, fn),
    [store, key]
  );
  return useSyncExternalStore(subscribe, () => store.get(key));
}
