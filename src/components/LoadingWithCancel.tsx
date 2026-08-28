import { useEffect, useRef, useState } from "react";
import { cancelSchemaLoad } from "../api";
import type { DbType } from "../types";

/** バックエンドが「中止」を伝えるときの文言 (db.rs の cancelled_message と対) */
const CANCELLED = "実行を中止しました";

/** 自分で押した「中止」の結果か (エラーとして赤く出さないための判定) */
export function isCancelled(message: string): boolean {
  return message.includes(CANCELLED);
}

interface Props {
  /** 「スキーマを読み込み中...」など */
  label: string;
  /** 中止する接続 (差分ビューアは左右2つある) */
  sessionIds: string[];
  /** 接続の種類 (SQLiteは実行中SQLを中止できないのでボタンを出さない) */
  dbTypes?: (DbType | undefined)[];
}

/**
 * 時間の掛かる読み込みの表示と中止ボタン。
 *
 * スキーマの収集はテーブル数が多いDBだと長く掛かる。
 * MySQL / PostgreSQL は専用の接続で集めるのでタブの操作は止まらないが、
 * 待ちたくないときのために、SQL実行と同じ仕組み (別接続からのKILL) で
 * 止められるようにしておく
 */
export function LoadingWithCancel({ label, sessionIds, dbTypes }: Props) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const ids = sessionIds.filter(Boolean);
  // SQLiteは他プロセスから中断できないため、押せないボタンは出さない
  const cancellable =
    ids.length > 0 && !(dbTypes ?? []).some((t) => t === "sqlite");

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );

  const cancel = async () => {
    setSent(true);
    setError(null);
    if (timer.current) window.clearTimeout(timer.current);
    try {
      await Promise.all(ids.map((id) => cancelSchemaLoad(id)));
      // 問い合わせの合間に届くと空振りするので、少し待って押し直せるようにする
      timer.current = window.setTimeout(() => setSent(false), 3000);
    } catch (e) {
      setError(`中止できませんでした: ${e}`);
      setSent(false);
    }
  };

  return (
    <div className="content-placeholder dim-center">
      <span className="spinner accent" /> {label}
      {cancellable && (
        <button
          className="btn-secondary loading-cancel"
          onClick={cancel}
          disabled={sent}
          title="読み込みを中止します (接続は切れません)"
        >
          {sent ? "中止しています..." : "中止"}
        </button>
      )}
      {error && <span className="console-error">{error}</span>}
    </div>
  );
}
