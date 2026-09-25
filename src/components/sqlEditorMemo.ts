/**
 * SQLエディタの見た目の控え: スクロール位置とカーソル (選択) の位置。
 *
 * テーブル画面へ切り替えたりシートを移ったりするとエディタは作り直されるので、
 * そのままでは先頭へ戻ってしまう。シートごとに控えておき、作り直したときに戻す。
 * 本文が変わっていたら (長さが違えば) 位置が合わないので戻さない
 */

export interface EditorViewMemo {
  /** EditorView.scrollSnapshot() の結果 (そのまま dispatch すれば位置が戻る) */
  snapshot: unknown;
  anchor: number;
  head: number;
  /** 控えたときの本文の長さ */
  docLength: number;
}

/** 覚えておくシートの数 (古いものから捨てる) */
export const EDITOR_MEMO_LIMIT = 200;

/** 挿入順 = 使った順 */
const memo = new Map<string, EditorViewMemo>();

/** 控えを書く */
export function saveEditorView(key: string, state: EditorViewMemo): void {
  memo.delete(key);
  memo.set(key, state);
  while (memo.size > EDITOR_MEMO_LIMIT) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

/** 控えを読む (本文の長さが違えば使わない) */
export function loadEditorView(
  key: string,
  docLength: number
): EditorViewMemo | undefined {
  const v = memo.get(key);
  return v && v.docLength === docLength ? v : undefined;
}
