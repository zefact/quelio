/**
 * トランザクションの状態を読み、変化に追従する。
 *
 * 状態を持っているのはバックエンドなので、こちらからは読みに行く。
 * 読むきっかけは「タブを切り替えたとき」「実行が終わったとき」など、
 * 状態が変わりうる場面だけ (sessionId / watch が変わったとき)
 */
import { useCallback, useEffect, useState } from "react";
import { endTxn, getTxnState } from "../api";
import type { TxnStatus } from "../types";

/** 画面に出す状態 ("busy" は表示には使わない) */
type Shown = Exclude<TxnStatus, "busy">;

export interface TxnControl {
  txn: Shown;
  /** 確定 / 取り消しの実行中 */
  busy: boolean;
  /** 閉じられなかったときの文言 */
  error: string | null;
  /** 確定 (true) / 取り消し (false) */
  end: (commit: boolean) => Promise<void>;
}

/** 読めなかったときに待つ時間と、諦めるまでの回数 */
const RETRY_MS = 200;
const RETRIES = 5;

export function useTxnState(
  sessionId: string,
  /** 状態が変わりうる場面を表す目印 (変わると読み直す) */
  watch: string,
  /** 接続していない画面では読みに行かない */
  enabled = true
): TxnControl {
  /*
   * どの接続の状態かを一緒に持つ。
   * タブを切り替えた直後に、前のタブの状態を出してしまわないようにする
   */
  const [state, setState] = useState<{ id: string; txn: Shown }>({
    id: "",
    txn: "none",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer = 0;
    /*
     * 実行中や、テーブル一覧の取得中は接続が使用中で "busy" が返る。
     * 少し待って読み直す (一覧の取得のような短い処理なら、すぐ読めるようになる)。
     * 長い実行は、終わったときに watch が変わって読み直されるので、
     * ここは数回で打ち切ってよい
     */
    const read = (rest: number) => {
      getTxnState(sessionId)
        .then((s) => {
          if (!alive) return;
          if (s !== "busy") {
            setState({ id: sessionId, txn: s });
            return;
          }
          if (rest > 0) {
            timer = window.setTimeout(() => read(rest - 1), RETRY_MS);
          }
        })
        // 未接続・切断直後は読めなくて当然なので黙って諦める
        .catch(() => {});
    };
    read(RETRIES);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [sessionId, watch, enabled]);

  const end = useCallback(
    async (commit: boolean) => {
      setBusy(true);
      setError(null);
      try {
        // 閉じた直後は必ず読めるので "busy" は返らないが、型を合わせておく
        const next = await endTxn(sessionId, commit);
        if (next !== "busy") setState({ id: sessionId, txn: next });
      } catch (e) {
        setError(String(e));
        // 閉じられなかった場合の状態を読み直す (壊れている可能性がある)
        getTxnState(sessionId)
          .then((s) => s !== "busy" && setState({ id: sessionId, txn: s }))
          .catch(() => {});
      } finally {
        setBusy(false);
      }
    },
    [sessionId]
  );

  return {
    // まだ読めていない接続は「無し」として出す
    txn: enabled && state.id === sessionId ? state.txn : "none",
    busy,
    error,
    end,
  };
}
