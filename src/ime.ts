/**
 * 日本語入力 (IME) の変換中のキーを、アプリの操作と取り違えないための判定。
 *
 * 変換中かどうかは本来 `isComposing` で分かるが、Mac (WebKit) では
 * 変換の終わり (compositionend) が「確定のEnter」より先に届き、
 * そのEnterの `isComposing` が false になる。
 * そのままだと、変換を確定したEnterで保存されたりモーダルが閉じたりする。
 *
 * そこで次のどれかに当たるキーは「変換の操作」とみなす。
 * - isComposing が立っている
 * - keyCode が 229 (変換中を表す古い印。WebKitは確定のEnterにも付ける)
 * - 変換が終わった直後の Enter / Escape (確定・取り消しの合図)
 *
 * 変換の始まりと終わりは document で1か所だけ見張る (入力欄ごとに仕込まなくてよい)
 */

/** 変換を終えた直後、Enter / Escape を操作に使わない時間 (ミリ秒) */
export const IME_GRACE_MS = 120;

/** 判定に使うキー操作の中身 (DOMのKeyboardEventとReactのものの両方から取れる) */
export interface KeyLike {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
}

/** 変換の始まり・終わりを覚えて判定する (テストのため時計を差し替えられる) */
export function createImeTracker(now: () => number = Date.now) {
  let composing = false;
  let endedAt = -Infinity;
  return {
    start() {
      composing = true;
    },
    end() {
      composing = false;
      endedAt = now();
    },
    /** このキーは変換の操作か (アプリの操作として扱わない) */
    busy(e: KeyLike): boolean {
      if (e.isComposing || composing || e.keyCode === 229) return true;
      if (e.key === "Enter" || e.key === "Escape") {
        return now() - endedAt < IME_GRACE_MS;
      }
      return false;
    },
  };
}

const tracker = createImeTracker();

if (typeof document !== "undefined") {
  // 入力欄より先に知るため、捕捉フェーズで受け取る
  document.addEventListener("compositionstart", () => tracker.start(), true);
  document.addEventListener("compositionend", () => tracker.end(), true);
}

/**
 * 変換中 (または確定・取り消しの直後) のキーか。
 * Enterで決定・Escで閉じる処理の最初に `if (imeBusy(e)) return;` と書く
 */
export function imeBusy(e: KeyLike | { nativeEvent: KeyLike }): boolean {
  return tracker.busy("nativeEvent" in e ? e.nativeEvent : e);
}
