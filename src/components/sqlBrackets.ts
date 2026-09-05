/**
 * 括弧の色分け。
 *
 * 深さごとに色を変えて、どれとどれが対なのかを目で追えるようにする
 * (VSCodeの「括弧ペアの色分け」と同じ考え方)。相手のいない括弧は
 * 別の色にするので、閉じ忘れもその場で分かる。
 *
 * 文字列やコメントの中の括弧は数えない。構文木ではなく字面で読むのは、
 * 書きかけで構文が壊れていても数え続けられるようにするため
 */
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
import type { DbType } from "../types";

/** 見つけた括弧1つ */
export interface Bracket {
  /** 文書の中の位置 */
  at: number;
  /** 入れ子の深さ (いちばん外側が0) */
  depth: number;
  /** 相手のいない括弧 */
  bad: boolean;
}

/** 方言ごとの読み方の違い */
export interface ScanOpts {
  /** `#` から行末までがコメント (MySQL) */
  hashComment?: boolean;
  /** 文字列の中で `\` が次の1文字を逃がす (MySQLの既定) */
  backslash?: boolean;
  /** `$タグ$ … $タグ$` の引用 (PostgreSQL) */
  dollarQuote?: boolean;
}

/** 接続先に合わせた読み方 */
export function scanOptsFor(dbType: DbType): ScanOpts {
  if (dbType === "mysql") return { hashComment: true, backslash: true };
  if (dbType === "postgresql") return { dollarQuote: true };
  return {};
}

/** 引用符の終わりの次の位置 (閉じていなければ末尾) */
function skipQuoted(text: string, at: number, opts: ScanOpts): number {
  const q = text[at];
  // 逃がせるのは文字列だけ。名前を囲む " や ` の中では `\` はただの文字
  const escapes = opts.backslash && q === "'";
  let i = at + 1;
  while (i < text.length) {
    const c = text[i];
    if (escapes && c === "\\") {
      i += 2;
      continue;
    }
    if (c === q) {
      // 同じ引用符を2つ並べると、引用符1文字ぶんになる
      if (text[i + 1] === q) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return text.length;
}

/** `$タグ$` の終わりの次の位置。その形でなければ -1 */
function dollarTagEnd(text: string, at: number): number {
  let i = at + 1;
  while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++;
  return text[i] === "$" ? i + 1 : -1;
}

/** ブロックコメントの終わりの次の位置 (PostgreSQLは入れ子になる) */
function skipBlockComment(text: string, at: number): number {
  let level = 1;
  let i = at + 2;
  while (i < text.length && level > 0) {
    if (text[i] === "/" && text[i + 1] === "*") {
      level++;
      i += 2;
    } else if (text[i] === "*" && text[i + 1] === "/") {
      level--;
      i += 2;
    } else {
      i++;
    }
  }
  return i;
}

/** 開き括弧と、その相手 */
const PAIR: Record<string, string> = { "(": ")", "[": "]" };

/**
 * SQLの中の括弧を、前から順に拾う。
 *
 * 返す並びは位置の順。相手のいない括弧 (閉じ忘れ・余った閉じ括弧) は
 * bad を立てて返す
 */
export function scanBrackets(text: string, opts: ScanOpts = {}): Bracket[] {
  const out: Bracket[] = [];
  /** まだ閉じていない開き括弧 (out の添字) */
  const openAt: number[] = [];
  /** 上と対になる、待っている閉じ文字 */
  const want: string[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const c = text[i];

    // 行コメント
    if ((c === "-" && text[i + 1] === "-") || (opts.hashComment && c === "#")) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    // ブロックコメント
    if (c === "/" && text[i + 1] === "*") {
      i = skipBlockComment(text, i);
      continue;
    }
    // 文字列・名前の引用
    if (c === "'" || c === '"' || c === "`") {
      i = skipQuoted(text, i, opts);
      continue;
    }
    // $タグ$ … $タグ$
    if (opts.dollarQuote && c === "$") {
      const head = dollarTagEnd(text, i);
      if (head > 0) {
        const tag = text.slice(i, head);
        const close = text.indexOf(tag, head);
        i = close < 0 ? n : close + tag.length;
        continue;
      }
    }

    if (c === "(" || c === "[") {
      out.push({ at: i, depth: openAt.length, bad: false });
      openAt.push(out.length - 1);
      want.push(PAIR[c]);
    } else if (c === ")" || c === "]") {
      if (want[want.length - 1] === c) {
        openAt.pop();
        want.pop();
        out.push({ at: i, depth: openAt.length, bad: false });
      } else {
        // 開いていない括弧を閉じている
        out.push({ at: i, depth: 0, bad: true });
      }
    }
    i++;
  }

  // 閉じ忘れも同じ扱いにする
  for (const k of openAt) out[k].bad = true;
  return out;
}

/** 色の本数 (これで割った余りで色を選ぶ) */
export const BRACKET_COLORS = 3;

const MARKS = Array.from({ length: BRACKET_COLORS }, (_, i) =>
  Decoration.mark({ class: `cm-bracket-${i}` })
);
const BAD = Decoration.mark({ class: "cm-bracket-bad" });

/**
 * これより長い文には色を付けない。
 *
 * 1文字打つたびに全体を読み直すので、際限なく重くならないようにする
 */
const MAX_LENGTH = 200_000;

function build(view: EditorView, opts: ScanOpts): DecorationSet {
  const doc = view.state.doc;
  if (doc.length > MAX_LENGTH) return Decoration.none;
  const found = scanBrackets(doc.toString(), opts);
  if (found.length === 0) return Decoration.none;

  // 印を置くのは見えている所だけ (画面の外まで作らない)
  const b = new RangeSetBuilder<Decoration>();
  let k = 0;
  for (const { from, to } of view.visibleRanges) {
    while (k < found.length && found[k].at < from) k++;
    while (k < found.length && found[k].at < to) {
      const m = found[k];
      b.add(m.at, m.at + 1, m.bad ? BAD : MARKS[m.depth % BRACKET_COLORS]);
      k++;
    }
  }
  return b.finish();
}

/** 括弧の色分けを入れる */
export function bracketColors(dbType: DbType): Extension {
  const opts = scanOptsFor(dbType);
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, opts);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) {
          this.decorations = build(u.view, opts);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}
