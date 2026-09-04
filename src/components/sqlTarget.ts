/**
 * 「実行ボタンを押したら何が走るか」を決める部分。
 *
 * カーソルのある文だけが走る、というのは押してみないと分からなかった。
 * ここで対象の文を割り出し、エディタでは帯を敷き、
 * ボタンには「この文を実行 (2/3)」と出して、押す前に分かるようにする。
 *
 * 文の分け方は方言によるのでバックエンドが決める。
 * ここは受け取った範囲を持ち回るだけなので、画面に依存しない
 */
import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { spanAt } from "../sqlSpans";
import type { SqlSpan } from "../sqlSpans";

/** 分け直した文の範囲を流し込む */
export const setSpansEffect = StateEffect.define<SqlSpan[]>();

/** 今エディタが持っている文の範囲 */
export const spansField = StateField.define<SqlSpan[]>({
  create: () => [],
  update(spans, tr) {
    for (const e of tr.effects) {
      if (e.is(setSpansEffect)) return e.value;
    }
    /*
     * 打っている間も帯がずれないよう、位置を今の文書に合わせて動かす。
     * 分け直した範囲は少し遅れて届くので、その間のつなぎになる
     */
    if (!tr.docChanged) return spans;
    return spans.map((s) => ({
      text: s.text,
      from: tr.changes.mapPos(s.from),
      to: tr.changes.mapPos(s.to, 1),
    }));
  },
});

/**
 * 実行ボタンが流す文。
 *
 * 選択しているときは選択部分が走るので対象なし。
 * 1文しか無いときは「実行=全体」なので、わざわざ示さない
 */
export function targetSpan(state: EditorState): SqlSpan | null {
  const spans = state.field(spansField, false) ?? [];
  if (spans.length <= 1) return null;
  const sel = state.selection.main;
  if (!sel.empty) return null;
  return spanAt(spans, sel.head);
}

/** 実行対象が何文目か (0始まり。対象なしは -1) と、文の数 */
export function targetAt(state: EditorState): {
  index: number;
  total: number;
} {
  const spans = state.field(spansField, false) ?? [];
  const span = targetSpan(state);
  return { index: span ? spans.indexOf(span) : -1, total: spans.length };
}

/** 帯を敷く行の範囲 (先頭行と最終行の行番号。対象が無ければ null) */
export function targetLines(
  state: EditorState
): { first: number; last: number } | null {
  const span = targetSpan(state);
  if (!span) return null;
  const len = state.doc.length;
  return {
    first: state.doc.lineAt(Math.min(span.from, len)).number,
    last: state.doc.lineAt(Math.min(span.to, len)).number,
  };
}
