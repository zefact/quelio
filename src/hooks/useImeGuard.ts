import { useRef } from "react";

/**
 * 日本語入力の「変換を確定するEnter」を、決定の合図と取り違えないための道具。
 *
 * 変換中かどうかは本来 `isComposing` で分かるが、WebKitでは
 * 変換の終わり (compositionend) が確定のEnterより先に届くことがあり、
 * そのEnterが「決定」として扱われてしまう。
 * 変換の始まりと終わりを自分で覚えておき、
 * 終わった直後のEnterも決定には使わないようにする
 */

/** 変換を確定した直後、Enterを決定に使わない時間 (ミリ秒) */
const GRACE_MS = 120;

export interface ImeGuard {
  /** 入力欄にそのまま渡す (変換の始まり・終わりを覚える) */
  props: {
    onCompositionStart: () => void;
    onCompositionEnd: () => void;
  };
  /** そのキー操作を決定・取り消しとして扱ってよいか */
  ready: (e: React.KeyboardEvent) => boolean;
}

export function useImeGuard(): ImeGuard {
  const composing = useRef(false);
  const endedAt = useRef(0);
  return {
    props: {
      onCompositionStart: () => {
        composing.current = true;
      },
      onCompositionEnd: () => {
        composing.current = false;
        endedAt.current = Date.now();
      },
    },
    ready: (e) => {
      // 変換中は何も拾わない (229 は変換中を表す古い印)
      if (e.nativeEvent.isComposing || composing.current) return false;
      if (e.nativeEvent.keyCode === 229) return false;
      // 変換を確定した直後のEnterは、確定の合図なので決定には使わない
      if (e.key === "Enter" && Date.now() - endedAt.current < GRACE_MS) {
        return false;
      }
      return true;
    },
  };
}
