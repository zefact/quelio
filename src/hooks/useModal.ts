import { useEffect, useRef } from "react";

/**
 * 開いているモーダルの重なり順 (後ろほど手前)。
 * Escは手前の1枚だけが受け取る。
 * windowの捕捉フェーズは登録順に呼ばれるので、
 * これが無いと外側 (先に開いたほう) が閉じてしまう
 */
const stack: symbol[] = [];

/**
 * モーダルの共通の作法をまとめる。
 * - Escで閉じる (入力欄にフォーカスが無くても効くようwindowで拾う)
 * - 開いたときに1度だけ枠へフォーカスする (キー操作を受け取れるように)
 *
 * 返ってきたrefをモーダルの枠 (tabIndex={-1} を付けた要素) に渡す
 */
export function useModal<T extends HTMLElement = HTMLDivElement>(
  onClose: () => void,
  /** falseの間はEscで閉じない (実行中など) */
  enabled = true
) {
  const boxRef = useRef<T>(null);
  /** このモーダルを重なり順の中で見分けるための印 */
  const id = useRef<symbol>(null as unknown as symbol);
  if (id.current === null) id.current = Symbol("modal");

  // 開いたときに1度だけ (毎レンダーの再フォーカスはしない)
  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  // 開いている間だけ重なり順に載せる (enabledとは無関係)
  useEffect(() => {
    const me = id.current;
    stack.push(me);
    return () => {
      const at = stack.lastIndexOf(me);
      if (at !== -1) stack.splice(at, 1);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      // 手前に別のモーダルが開いているなら、そちらに任せる
      if (stack[stack.length - 1] !== id.current) return;
      // 日本語入力の変換を取り消したEscで閉じないようにする
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      // 下にある画面が同じEscに反応しないよう、ここで処理済みにする
      e.preventDefault();
      onClose();
    };
    // 下の画面より先に受け取る (捕捉フェーズ) ことで、
    // グリッドの編集取り消しなどと二重に反応させない
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, enabled]);

  return boxRef;
}
