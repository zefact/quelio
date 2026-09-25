/**
 * 表 (ResizableGrid) の見た目の控え: スクロール位置・描いた行数・列幅。
 *
 * 画面を切り替えると表は作り直されるので、そのままでは先頭へ戻ってしまう。
 * 表示していたデータ (取得結果のオブジェクト) ごとに控えておき、
 * 同じデータで作り直されたときに元の位置へ戻す。
 * データを取り直したら別のオブジェクトになるので、自然に先頭から始まる。
 * WeakMap なので、データが捨てられれば控えも一緒に消える
 */

export interface GridViewState {
  top: number;
  left: number;
  /** 描いていた行数 (続きを描き足していたぶん) */
  shown: number;
  /** 列幅 (手で変えたものも含む) */
  widths: Record<string, number>;
  /** 並べ替えなどの状態 (違っていたら戻さない) */
  sig: string;
}

const memo = new WeakMap<object, GridViewState>();

/** 控えを読む (並べ替えなどが違えば使わない) */
export function loadGridView(key: object | undefined, sig: string): GridViewState | undefined {
  if (!key) return undefined;
  const v = memo.get(key);
  return v && v.sig === sig ? v : undefined;
}

/** 控えを書く */
export function saveGridView(key: object | undefined, state: GridViewState): void {
  if (key) memo.set(key, state);
}
