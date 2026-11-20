import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";

/** 確認ダイアログに出す内容 */
export interface AskOptions {
  /** 見出し (例: カラムの定義を変更します) */
  title: string;
  /** 見出しの右に出す対象名 */
  target?: string;
  /** 実行ボタンの文字 (動詞で書く) */
  confirmLabel: string;
  /** 消す・壊す操作だけ danger にする */
  tone?: "danger" | "primary";
  /** 本番のときの1行 (渡すとバッジを出し、フォーカスを「キャンセル」に置く) */
  prodNote?: ReactNode;
  /** 本文 */
  body?: ReactNode;
  /**
   * 実行するSQL (本文の下に出す)。
   * 組み立てに時間が掛かるものは Promise のまま渡してよい (届いたら出す)
   */
  sql?: string[] | Promise<string[]>;
}

type Pending = AskOptions & { resolve: (ok: boolean) => void };

/** 実行するSQLを見せる欄 (Promise なら届くのを待つ) */
function SqlPreview({ sql }: { sql: string[] | Promise<string[]> }) {
  const [lines, setLines] = useState<string[] | null>(
    Array.isArray(sql) ? sql : null
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (Array.isArray(sql)) return;
    let alive = true;
    sql
      .then((s) => alive && setLines(s))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [sql]);
  if (failed || (lines && lines.length === 0)) return null;
  return (
    <>
      <div className="confirm-sql-head">実行するSQL</div>
      <pre className="mono confirm-sql">
        {lines ? lines.join("\n") : "組み立て中…"}
      </pre>
    </>
  );
}

/**
 * 「実行してよいか」を確認ダイアログで聞き、答えを Promise で返す。
 *
 * 編集の確定のように、実行する関数の途中で一度止めたいところで使う。
 * `await ask({...})` が true なら実行、false ならキャンセル。
 * 戻り値の2つめ (ダイアログ) を画面のどこかに置くこと
 */
export function useAskConfirm(): [
  (opts: AskOptions) => Promise<boolean>,
  ReactNode,
] {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  // 画面が消えたら、待っている側には「キャンセル」と答える
  useEffect(
    () => () => {
      pendingRef.current?.resolve(false);
    },
    []
  );

  const ask = useCallback(
    (opts: AskOptions) =>
      new Promise<boolean>((resolve) => {
        // 前の確認が残っていれば、そちらはキャンセル扱いにする
        pendingRef.current?.resolve(false);
        setPending({ ...opts, resolve });
      }),
    []
  );

  const answer = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const dialog = pending ? (
    <ConfirmDialog
      title={pending.title}
      target={pending.target}
      confirmLabel={pending.confirmLabel}
      tone={pending.tone ?? "primary"}
      prodNote={pending.prodNote}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
    >
      {pending.body}
      {pending.sql && <SqlPreview sql={pending.sql} />}
    </ConfirmDialog>
  ) : null;

  return [ask, dialog];
}
