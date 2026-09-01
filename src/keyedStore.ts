/**
 * キーごとに状態を持つ、画面の外の置き場。
 *
 * タブや表示を切り替えると、その画面の部品はいったん外れる。
 * Reactのstateだけで持っていると、時間のかかる処理 (CSVの出力・取り込み) の
 * 進捗や中止ボタンが戻ってきたときに消えてしまうため、
 * 消えては困る状態だけをここに預ける。
 *
 * 画面からは `useKeyedStore` で読む
 */

export interface KeyedStore<T extends object> {
  /** 今の状態 (預けていなければ「空」) */
  get(key: string): T;
  /** 一部だけ書き換えて、見ている画面へ知らせる */
  patch(key: string, patch: Partial<T>): void;
  /** 変化を受け取る (戻り値を呼ぶと解除) */
  subscribe(key: string, fn: () => void): () => void;
  /** 1件捨てる (タブを閉じたときなど) */
  drop(key: string): void;
  /** すべて捨てる (テスト用) */
  reset(): void;
}

/**
 * 置き場を作る。
 *
 * @param empty 預けていないキーに返す「空」の状態。
 *   毎回同じ実体を返す (中身が同じでも参照が変わると、画面が更新され続けるため)
 */
export function createKeyedStore<T extends object>(empty: T): KeyedStore<T> {
  const states = new Map<string, T>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (key) => states.get(key) ?? empty,
    patch(key, patch) {
      states.set(key, { ...(states.get(key) ?? empty), ...patch });
      listeners.get(key)?.forEach((fn) => fn());
    },
    subscribe(key, fn) {
      const set = listeners.get(key) ?? new Set<() => void>();
      set.add(fn);
      listeners.set(key, set);
      return () => {
        set.delete(fn);
        if (set.size === 0) listeners.delete(key);
      };
    },
    drop(key) {
      states.delete(key);
      listeners.delete(key);
    },
    reset() {
      states.clear();
      listeners.clear();
    },
  };
}
