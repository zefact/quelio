import { useSyncExternalStore } from "react";
import { checkConnection } from "../api";
import {
  lostSnapshot,
  markChecking,
  subscribeLost,
  type LostInfo,
} from "../connLost";

/** すべてのタブの切断の印 (タブ列で使う) */
export function useLostSessions(): ReadonlyMap<string, LostInfo> {
  return useSyncExternalStore(subscribeLost, lostSnapshot);
}

/** そのタブの切断の印 (切れていなければ null) */
export function useConnLost(sessionId: string): LostInfo | null {
  return useLostSessions().get(sessionId) ?? null;
}

/**
 * 「接続し直す」。
 * 生きているか確かめ、切れていれば張り直す。
 * 成功すれば印は消え、失敗すれば新しいエラーで印が残る (connLost の watchSession)
 */
export function reconnectSession(sessionId: string): void {
  markChecking(sessionId);
  checkConnection(sessionId).catch(() => {
    // 失敗の理由は印に残る (画面の帯に出る)
  });
}
