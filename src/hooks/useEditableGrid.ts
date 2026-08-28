import { useEffect, useRef, useState } from "react";

/**
 * 一覧をその場で編集する画面 (カラム / インデックス) で共通する仕組みをまとめたもの。
 * 画面ごとに違う「何を編集中か」は各コンポーネントが持ち、
 * ここでは実行中の状態・フォーカス移動・Escでの取り消しだけを扱う。
 */

/**
 * 変更の実行 (ALTER等) を包む。
 *
 * 実行中は busy、失敗したら error に理由を入れる。
 * 直せるように、失敗しても編集状態は呼び出し側で残すこと。
 *
 * @returns 成功したら true
 */
export function useAsyncApply<C>(onApply: (change: C) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 依存に入れずに最新を呼べるようにする
  const applyRef = useRef(onApply);
  applyRef.current = onApply;

  const run = async (change: C): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await applyRef.current(change);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  /**
   * 失敗の理由を呼び出し元 (確認ダイアログなど) に伝えたいときはこちら。
   * 実行中の表示だけ受け持ち、例外はそのまま投げ直す
   */
  const runOrThrow = async (change: C): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await applyRef.current(change);
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, setError, run, runOrThrow };
}

/**
 * 編集対象のセルが変わったら、その入力欄へフォーカスを移す。
 *
 * 同じ行の別セルをダブルクリックしたときは要素が作り直されないため、
 * autoFocusだけでは移動しない。
 *
 * @param focusKey `...:フィールド名` の形。編集していないときは空文字
 * @param attr 入力欄に付けているデータ属性名 (例 "data-field")
 */
export function useGridFocus(focusKey: string, attr: string) {
  useEffect(() => {
    if (!focusKey) return;
    const field = focusKey.slice(focusKey.lastIndexOf(":") + 1);
    const el = document.querySelector<HTMLInputElement>(
      `.grid tr.row-editing [${attr}="${field}"]`
    );
    el?.focus();
    if (el?.type === "text") el.select();
  }, [focusKey, attr]);
}

/**
 * 入力欄からフォーカスが外れていてもEscで編集を取り消せるようにする。
 *
 * @param active 取り消せるものがあるときだけ true
 * @param onCancel 取り消す処理
 * @param opts.busy 実行中は取り消させない
 * @param opts.blocked ダイアログを開いている等、そちらに任せたいときは true
 * @param opts.preventDefault 同じEscで他の処理まで走らせたくないときは true
 */
export function useEscapeCancel(
  active: boolean,
  onCancel: () => void,
  opts: { busy?: boolean; blocked?: boolean; preventDefault?: boolean } = {}
) {
  const { busy = false, blocked = false, preventDefault = false } = opts;
  const cb = useRef(onCancel);
  cb.current = onCancel;

  useEffect(() => {
    if (!active || busy || blocked) return;
    const onKey = (e: KeyboardEvent) => {
      // 他で処理済みのEscや、変換中のEscは拾わない
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (preventDefault) e.preventDefault();
      cb.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, busy, blocked, preventDefault]);
}
