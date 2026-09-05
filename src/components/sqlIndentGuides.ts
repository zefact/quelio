/**
 * 字下げの縦線。
 *
 * どの行がどの段に属しているのかを、薄い縦線で追えるようにする。
 * カーソルのいるまとまりの線だけは濃くして、今どこを書いているのかが
 * ひと目で分かるようにする。
 *
 * 線は行の背景として描く (文字を足さないので、選択やコピーには入らない)
 */
import { getIndentUnit } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";

/** 空白だけの行 (段は前後から決める) */
export const BLANK = -1;

/**
 * 行の字下げが何段ぶんか。
 *
 * タブは次の桁位置まで進むものとして数える。
 * 空白だけの行はここでは決められないので BLANK を返す
 */
export function indentDepth(
  line: string,
  unit: number,
  tabSize: number
): number {
  let col = 0;
  for (const ch of line) {
    if (ch === " ") col++;
    else if (ch === "\t") col += tabSize - (col % tabSize);
    else return Math.floor(col / unit);
  }
  return BLANK;
}

/**
 * 空白だけの行の段を、前後の浅いほうに合わせる。
 *
 * 段の切れ目に空行があっても線が途切れないようにする。
 * 深いほうに合わせると、ブロックの外の空行にまで線が伸びてしまう
 */
export function fillBlanks(depths: number[]): number[] {
  const out = depths.slice();
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== BLANK) continue;
    let end = i;
    while (end < out.length && out[end] === BLANK) end++;
    const before = i > 0 ? depths[i - 1] : 0;
    const after = end < out.length ? depths[end] : 0;
    const depth = Math.min(before, after);
    for (let k = i; k < end; k++) out[k] = depth;
    i = end - 1;
  }
  return out;
}

/** 濃くする線の位置 (at: 左から何本目か) と、引く行の範囲 */
export interface ActiveGuide {
  /** 段の番号 (0が左端の線) */
  at: number;
  /** 濃くする最初の行 (0から数える) */
  from: number;
  /** 濃くする最後の行 */
  to: number;
}

/**
 * カーソルのいるまとまりの線を選ぶ。
 *
 * 選ぶのは「その行が入っているまとまり」の線。
 * ただしカーソルがまとまりの見出し (次の行から深くなる行) にいるときは、
 * これから書く中身のほうの線を選ぶ。
 * 線を引くのは中身の行だけで、見出しの行には引かない (VSCodeと同じ)
 */
export function activeGuide(
  depths: number[],
  line: number
): ActiveGuide | null {
  const here = depths[line];
  if (here === undefined) return null;

  const below = depths[line + 1];
  const opens = below !== undefined && below > here;
  const at = opens ? here : here - 1;
  if (at < 0) return null;

  let from = line;
  if (here <= at) {
    // 見出しの行にいるので、中身は次の行から
    from = line + 1;
    if ((depths[from] ?? -1) <= at) return null;
  }
  let to = from;
  while (from > 0 && depths[from - 1] > at) from--;
  while (to + 1 < depths.length && depths[to + 1] > at) to++;
  return { at, from, to };
}

/**
 * 行ごとの飾り。
 *
 * 線を何本引くか (--ig-n) と、1段の幅 (--ig-w) をCSSへ渡し、
 * 描くのはスタイル側に任せる。
 * 濃くする線があるときは、その位置 (--ig-a) も添える
 */
const cache = new Map<string, Decoration>();
function guideLine(count: number, unit: number, on: number): Decoration {
  const key = `${count}:${unit}:${on}`;
  const made = cache.get(key);
  if (made) return made;
  const base = `--ig-n:${count};--ig-w:${unit}ch`;
  const deco = Decoration.line({
    attributes:
      on < 0
        ? { class: "cm-indent-guides", style: base }
        : {
            class: "cm-indent-guides cm-indent-on",
            style: `${base};--ig-a:${on}`,
          },
  });
  cache.set(key, deco);
  return deco;
}

/** これより長い文には線を引かない (打つたびに全体を読み直すため) */
const MAX_LENGTH = 200_000;

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  if (doc.length > MAX_LENGTH) return Decoration.none;

  const unit = getIndentUnit(state);
  if (unit <= 0) return Decoration.none;
  const depths: number[] = [];
  for (const line of doc.iterLines()) {
    depths.push(indentDepth(line, unit, state.tabSize));
  }
  const filled = fillBlanks(depths);
  // カーソルのいる行 (選択しているときは、動かしているほうの端)
  const at = doc.lineAt(state.selection.main.head).number - 1;
  const active = activeGuide(filled, at);

  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const row = line.number - 1;
      const count = filled[row];
      const on =
        active && row >= active.from && row <= active.to ? active.at : -1;
      if (count > 0) b.add(line.from, line.from, guideLine(count, unit, on));
      if (line.to + 1 <= pos) break;
      pos = line.to + 1;
    }
  }
  return b.finish();
}

/** 字下げの縦線を入れる */
export function indentGuides(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        // 字下げの設定が変わると、線の間隔も変わる
        const unitChanged =
          getIndentUnit(u.startState) !== getIndentUnit(u.state);
        if (u.docChanged || u.selectionSet || u.viewportChanged || unitChanged) {
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}
