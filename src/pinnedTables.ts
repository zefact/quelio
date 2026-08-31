/**
 * ピン留めしたテーブルの並べ方。
 *
 * ピン留めしたものを先頭にまとめ、残りは元の並びのまま後ろに置く。
 * 複数選択 (Shiftの範囲) の基準も画面の並びと同じにしたいので、
 * 並べ替えはここ1か所に置く
 */

export interface SplitPinned<T> {
  /** ピン留めしたもの (元の並びのまま) */
  pinned: T[];
  /** それ以外 */
  rest: T[];
}

/** ピン留めの有無で2つに分ける */
export function splitPinned<T>(
  items: T[],
  keyOf: (item: T) => string,
  pinned: Set<string>
): SplitPinned<T> {
  if (pinned.size === 0) return { pinned: [], rest: items };
  const hit: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    if (pinned.has(keyOf(item))) hit.push(item);
    else rest.push(item);
  }
  return { pinned: hit, rest };
}

/** 画面に出る順 (ピン留め → それ以外) に並べ直す */
export function orderByPinned<T>(
  items: T[],
  keyOf: (item: T) => string,
  pinned: Set<string>
): T[] {
  const { pinned: hit, rest } = splitPinned(items, keyOf, pinned);
  return [...hit, ...rest];
}
