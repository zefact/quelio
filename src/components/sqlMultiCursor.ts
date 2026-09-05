/**
 * 矩形選択で立てた複数カーソルの動き。
 *
 * Option (Alt) を押しながらのドラッグで縦に選ぶと、行ごとにカーソルが立つ。
 * この状態は「同じ桁を並べて直す」ための道具なので、
 * 左右に動かしても縦の並びを保ちたい。
 *
 * そこで、カーソルの位置そのものではなく「今どの桁にいるか」を1つだけ覚え、
 * 押すたびにその桁を動かして、各行をその桁へ置き直す。
 * こうすると、短い行で行末に留まったカーソルも、
 * 桁が戻ってくれば元の縦の並びに戻る
 * (位置だけを見て動かすと、短い行のぶんがずれたままになる)
 */
import {
  EditorSelection,
  StateEffect,
  StateField,
  countColumn,
  findColumn,
} from "@codemirror/state";
import type { EditorState, Extension, SelectionRange } from "@codemirror/state";
import type { Command, KeyBinding } from "@codemirror/view";

/** 覚えている桁を入れ替える */
const setGoal = StateEffect.define<number | null>();

/**
 * 今どの桁を狙っているか。
 *
 * 左右キー以外でカーソルが動いたら忘れる
 * (別のところを選び直したら、そこから数え直す)
 */
const goalColumn = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGoal)) return e.value;
    if (tr.selection || tr.docChanged) return null;
    return value;
  },
});

/** その位置が何桁目か (タブは次の区切りまで数える) */
export function columnAt(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  return countColumn(line.text, state.tabSize, pos - line.from);
}

/**
 * どのカーソルにも共通の桁。
 *
 * 短い行で行末に留まっているカーソルは桁が小さく出るので、
 * いちばん大きいものを採る (それが動かし始めの縦のライン)
 */
function widest(
  state: EditorState,
  posOf: (r: SelectionRange) => number
): number {
  let out = 0;
  for (const r of state.selection.ranges) {
    out = Math.max(out, columnAt(state, posOf(r)));
  }
  return out;
}

/** カーソルのいる桁 */
export function headColumn(state: EditorState): number {
  return widest(state, (r) => r.head);
}

/** 選んだ範囲の端の桁 (右へ動かすなら右端、左なら左端) */
export function edgeColumn(state: EditorState, forward: boolean): number {
  return widest(state, (r) => (forward ? r.to : r.from));
}

/** いちばん長い行の桁 (これ以上は狙っても意味がないので、ここで止める) */
function lastColumn(state: EditorState): number {
  return widest(state, (r) => state.doc.lineAt(r.head).to);
}

/**
 * 押したあとに狙う桁。
 *
 * `stored` は覚えている桁 (まだ動かしていなければ null)。
 * 範囲を選んでいて広げないときは、ふつうの左右と同じくその端へ畳む
 */
export function nextColumn(
  state: EditorState,
  stored: number | null,
  forward: boolean,
  select: boolean
): number {
  const some = state.selection.ranges.some((r) => !r.empty);
  if (!select && some) return edgeColumn(state, forward);
  const from = stored ?? headColumn(state);
  const to = from + (forward ? 1 : -1);
  return Math.min(Math.max(0, to), lastColumn(state));
}

/** すべてのカーソルをその桁へ置いた選択 (行より短ければ行末で止まる) */
export function atColumn(
  state: EditorState,
  col: number,
  select: boolean
): EditorSelection {
  return EditorSelection.create(
    state.selection.ranges.map((r) => {
      const line = state.doc.lineAt(r.head);
      const to = line.from + findColumn(line.text, col, state.tabSize);
      return select
        ? EditorSelection.range(r.anchor, to)
        : EditorSelection.cursor(to);
    }),
    state.selection.mainIndex
  );
}

/** 複数カーソルのときだけ、桁を保ったまま動かす */
function byColumn(forward: boolean, select: boolean): Command {
  return (view) => {
    const { state } = view;
    // カーソルが1つのときは、いつもの動きに任せる
    if (state.selection.ranges.length < 2) return false;
    const col = nextColumn(state, state.field(goalColumn), forward, select);
    view.dispatch({
      selection: atColumn(state, col, select),
      effects: setGoal.of(col),
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  };
}

/** 狙っている桁を覚えておく入れ物 (キーと一緒に入れる) */
export const multiCursorState: Extension = goalColumn;

/**
 * 複数カーソルのときの左右キー。
 *
 * 標準のキー割り当てより前に置く (false を返した分はそちらへ渡る)
 */
export const multiCursorKeymap: KeyBinding[] = [
  { key: "ArrowRight", run: byColumn(true, false), shift: byColumn(true, true) },
  { key: "ArrowLeft", run: byColumn(false, false), shift: byColumn(false, true) },
];
