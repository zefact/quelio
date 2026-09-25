import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completionStatus,
  startCompletion,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  insertNewlineAndIndent,
} from "@codemirror/commands";
import { MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import {
  HighlightStyle,
  bracketMatching,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
} from "@codemirror/state";
import type { Line } from "@codemirror/state";
import type { Command } from "@codemirror/view";
import { rafThrottle } from "../rafThrottle";
import { loadEditorView, saveEditorView } from "./sqlEditorMemo";
import type { SqlSpan } from "../sqlSpans";
import {
  setSpansEffect,
  spansField,
  targetAt,
  targetLines,
} from "./sqlTarget";
import {
  Decoration,
  crosshairCursor,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
  rectangularSelection,
  tooltips,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { DbType, SqlIndent } from "../types";
import { watchCompletionLayout } from "./completionLayout";
import {
  completionCells,
  singleCursorOnly,
  sqlCompletion,
  type SchemaMap,
} from "./sqlCompletion";
import { sqlFunctionCompletion } from "./sqlFunctionCompletion";
import { bracketColors } from "./sqlBrackets";
import { indentGuides } from "./sqlIndentGuides";
import { multiCursorKeymap, multiCursorState } from "./sqlMultiCursor";

/*
 * 「今実行した文」を短い間だけ光らせる仕組み。
 *
 * 本物の選択にすると、そのまま入力したときに文が置き換わってしまう。
 * 見せるだけの飾りとして持つ
 */
const flashRangeEffect = StateEffect.define<{ from: number; to: number } | null>();

const flashMark = Decoration.mark({ class: "cm-ran" });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flashRangeEffect)) continue;
      next =
        e.value && e.value.to > e.value.from
          ? Decoration.set([flashMark.range(e.value.from, e.value.to)])
          : Decoration.none;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** 光らせておく時間 (ミリ秒) */
const FLASH_MS = 900;

/*
 * 検索で見つかった所に色を付ける仕組み。
 *
 * 本物の選択は「今いる1か所」にしか使えないので、
 * 残りの見つかった所は飾りとして自分で塗る
 */
const setFindsEffect = StateEffect.define<{
  ranges: { from: number; to: number }[];
  active: number;
}>();

const findMark = Decoration.mark({ class: "cm-find" });
const findActiveMark = Decoration.mark({ class: "cm-find-active" });

const findField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setFindsEffect)) continue;
      const { ranges, active } = e.value;
      next = Decoration.set(
        ranges
          .filter((r) => r.to > r.from)
          .map((r, i) =>
            (i === active ? findActiveMark : findMark).range(r.from, r.to)
          )
      );
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** 実行対象になる文の行に敷く帯 */
const targetLine = Decoration.line({ class: "cm-target" });

/** 実行対象の文に敷く帯を作る (どの文が対象かの判断は sqlTarget が持つ) */
function targetDecorations(state: EditorState): DecorationSet {
  const at = targetLines(state);
  if (!at) return Decoration.none;
  const marks = [];
  for (let n = at.first; n <= at.last; n++) {
    marks.push(targetLine.range(state.doc.line(n).from));
  }
  return Decoration.set(marks);
}

/** 字下げ1段ぶんの文字 (整形の設定と同じものを、エディタの入力でも使う) */
function indentText(indent: SqlIndent | undefined): string {
  if (indent === "tab") return "\t";
  return indent === "4" ? "    " : "  ";
}

/** 行頭の空白 (字下げ) を取り出す */
function indentOf(text: string): string {
  return /^[ \t]*/.exec(text)?.[0] ?? "";
}

/**
 * 改行したときの字下げ。
 *
 * 標準の動き (言語まかせ) は括弧の中しか見ないため、
 * 自分で字下げして書いていても改行のたびに行頭へ戻ってしまう。
 * 標準の結果と「直前の行の字下げ」を比べ、深い方を採る
 * (括弧の中でさらに下がる動きはそのまま残る)
 */
const insertNewlineSmart: Command = (view) => {
  const sel = view.state.selection;
  const before = view.state.doc.lineAt(sel.main.from);
  const prev = indentOf(before.text);
  if (!insertNewlineAndIndent(view)) return false;
  // 複数カーソルのときは、標準の結果をそのまま使う
  if (sel.ranges.length > 1) return true;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const now = indentOf(line.text);
  if (now.length >= prev.length) return true;
  view.dispatch({
    changes: { from: line.from, to: line.from + now.length, insert: prev },
    selection: { anchor: line.from + prev.length },
    userEvent: "input",
  });
  return true;
};

/** 選択が2行以上にまたがっているか (Tabの動きを分けるために見る) */
function spansLines(view: EditorView): boolean {
  const doc = view.state.doc;
  return view.state.selection.ranges.some(
    (r) => !r.empty && doc.lineAt(r.from).number !== doc.lineAt(r.to).number
  );
}

/**
 * 行番号を押したらその行を選ぶ。
 *
 * 押したまま動かせば行単位で伸ばせる。Shift+クリックは今の選択から伸ばす。
 * 行末の改行まで含めて選ぶので、そのまま削除すれば行ごと消える
 */
function selectLineFromGutter(
  view: EditorView,
  block: { from: number },
  event: Event
): boolean {
  const e = event as MouseEvent;
  if (e.button !== 0) return false;
  e.preventDefault();

  const doc = view.state.doc;
  const start = doc.lineAt(block.from);
  const anchorLine = e.shiftKey
    ? doc.lineAt(view.state.selection.main.anchor)
    : start;

  /** 起点の行と今の行から、行まるごとの選択を作る */
  const select = (head: Line) => {
    const down = anchorLine.number <= head.number;
    const from = down ? anchorLine.from : Math.min(anchorLine.to + 1, doc.length);
    const to = down ? Math.min(head.to + 1, doc.length) : head.from;
    view.dispatch({
      selection: EditorSelection.single(from, to),
      userEvent: "select",
    });
  };

  select(start);
  view.focus();

  // 押したまま動かしている間は、その行まで伸ばす
  const move = (m: MouseEvent) => {
    const at = view.posAtCoords({ x: m.clientX, y: m.clientY }, false);
    select(doc.lineAt(Math.max(0, Math.min(at, doc.length))));
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
  return true;
}

/** 親から選択テキストを取得するためのハンドル */
export interface SqlEditorHandle {
  getSelectedText(): string | null;
  /** カーソル位置 (文字数。選択しているときは選択の先頭) */
  getCursor(): number;
  /** 今実行した範囲を短い間だけ光らせる (選択はしない) */
  flashRange(from: number, to: number): void;
  /** カーソルの位置に文字列を差し込む (関数リファレンスから使う) */
  insertAtCursor(text: string): void;
  /** 本文そのもの (エディタ内検索が探す相手) */
  getText(): string;
  /** 今の選択範囲 (選んでいなければ from と to が同じ) */
  getRange(): { from: number; to: number };
  /** 範囲を選び、その位置まで画面を送る (入力位置は奪わない) */
  selectRange(from: number, to: number): void;
  /** 範囲をまとめて置き換える (置換。changes は前から順・重なり無し) */
  applyChanges(changes: { from: number; to: number; insert: string }[]): void;
  /**
   * 選んでいる範囲を差し替え、入れた文字をそのまま選び直す
   * (何に変わったかがすぐ見えるように)
   */
  replaceSelection(text: string): void;
  /** 見つかった所に色を付ける (空の配列で消す) */
  markFinds(ranges: { from: number; to: number }[], active: number): void;
  /** エディタへ入力位置を戻す */
  focusEditor(): void;
}

interface Props {
  value: string;
  dbType: DbType;
  placeholder: string;
  onChange: (value: string) => void;
  /** ⌘/Ctrl+Enter (実行ボタンと同じ動き) */
  onRun: () => void;
  /** ⌘/Ctrl+Shift+Enter (書いてあるSQLを全部実行) */
  onRunSelection: () => void;
  /** ⌘/Ctrl+Shift+F (SQLを整形) */
  onFormat: () => void;
  /** ⌘/Ctrl+Shift+S (SQLをファイルに保存) */
  onSaveFile: () => void;
  /** ⌘/Ctrl+Shift+H (関数リファレンスを開く) */
  onFunctions?: () => void;
  /** ⌘/Ctrl+F (エディタの中を探す) */
  onFind?: () => void;
  /**
   * 文ごとに分けた範囲。
   * 分け方は方言によるのでバックエンドが決め、ここは受け取るだけ
   */
  statements?: SqlSpan[];
  /** 実行対象が変わったとき (何文目 / 全部で何文。対象なしは -1) */
  onTarget?: (index: number, total: number) => void;
  onSelectionChange: (hasSelection: boolean) => void;
  onContextMenu: (x: number, y: number) => void;
  /**
   * 補完に使うテーブル・カラム名 ("テーブル名" → カラム名の配列)。
   * 接続先から取得したものを渡す
   */
  schema?: SchemaMap;
  /** 入力補完を使うか (設定) */
  autocomplete?: boolean;
  /** 入力補完が自動で開くまでの待ち時間 (ミリ秒)。0なら自動では開かない */
  autocompleteDelayMs?: number;
  /** 字下げ1段ぶん (設定 > エディタ > SQLの整形 の「字下げ」) */
  indent?: SqlIndent;
  /**
   * 見た目 (スクロール位置・カーソル) を控えておく名前 (シートごと)。
   * 画面を切り替えてエディタを作り直したとき、同じ名前の控えから元に戻す
   */
  memoKey?: string;
}

/** 入力補完の拡張 (無効なら何も入れない) */
function completionExt(
  enabled: boolean,
  delayMs: number,
  getSchema: () => SchemaMap,
  getDbType: () => DbType
) {
  if (!enabled) return [];
  return autocompletion({
    // 待ち時間が0のときは自動で開かず、⌥Spaceのときだけ出す
    activateOnTyping: delayMs > 0,
    activateOnTypingDelay: Math.max(delayMs, 1),
    icons: false,
    // ここを超えると一覧の下に「···」が出て、その先は続きを出す操作が要る。
    // カラムもテーブルもたいていこの数に収まるので、めったに出ない
    maxRenderedOptions: 200,
    // 名前の右に「テーブル名 / 日本語名 / 型」の列を足す
    addToOptions: completionCells,
    /*
     * 候補はテーブル・カラムと、そのDBの関数
     * (予約語は出さない)。関数は口を分けてある。
     * どちらも、矩形選択でカーソルが複数立っているときは出さない
     */
    override: [
      singleCursorOnly(sqlCompletion(getSchema)),
      singleCursorOnly(sqlFunctionCompletion(getDbType)),
    ],
  });
}

/**
 * 候補リストの置き場所。
 * エディタ枠の中だと overflow: hidden で切れるのでbody直下に出す。
 * アプリのレイアウト (flex) の影響を受けないよう、専用の箱を1つだけ作って使う
 */
function tooltipHost(): HTMLElement {
  const id = "cm-tooltip-host";
  const found = document.getElementById(id);
  if (found) return found;
  const host = document.createElement("div");
  host.id = id;
  document.body.appendChild(host);
  // 候補が出るたびに列幅を揃える
  watchCompletionLayout(host);
  return host;
}

/** DB種別に対応するSQLの方言 */
function dialectOf(dbType: DbType) {
  return dbType === "mysql" ? MySQL : dbType === "sqlite" ? SQLite : PostgreSQL;
}

/* シンタックスハイライト (色はテーマ変数でライト/ダーク両対応) */
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syn-keyword)", fontWeight: "700" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: t.number, color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: t.operator, color: "var(--syn-operator)" },
  { tag: [t.typeName, t.standard(t.name)], color: "var(--syn-type)" },
  { tag: t.function(t.variableName), color: "var(--syn-func)" },
  { tag: [t.punctuation, t.paren, t.bracket], color: "var(--text-dim)" },
]);

/* 等幅フォントは1か所 (theme.css の --font-mono) で決める */
const MONO = "var(--font-mono)";

/** エディタ共通テーマ (KvCommandEditorでも使う) */
export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "transparent",
    color: "var(--text)",
  },
  ".cm-scroller": {
    fontFamily: MONO,
    lineHeight: "1.65",
  },
  ".cm-content": {
    // drawSelectionを使うとOS標準のキャレットは隠れるため、
    // 実際の色は下の .cm-cursor が決める (ここは使わない場合の保険)
    caretColor: "var(--accent-2)",
    padding: "10px 0",
  },
  ".cm-line": { padding: "0 12px" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--text-faint)",
    borderRight: "1px solid var(--border)",
    fontSize: "12px",
    fontFamily: MONO,
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 10px 0 14px",
    minWidth: "36px",
    // 押すと行を選べるので、押せることが分かる形にする
    cursor: "default",
  },
  ".cm-lineNumbers .cm-gutterElement:hover": { color: "var(--text-dim)" },
  ".cm-activeLine": { backgroundColor: "rgba(var(--ink), 0.035)" },
  // 実行ボタンで走る文 (押す前から範囲が分かるようにする)
  ".cm-target": {
    backgroundColor: "rgba(99, 102, 241, 0.07)",
    boxShadow: "inset 2px 0 0 var(--accent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--text-dim)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgba(99, 102, 241, 0.32) !important",
  },
  ".cm-placeholder": { color: "var(--text-faint)" },
  ".cm-cursor": { borderLeftColor: "var(--accent-2)" },

  /*
   * 字下げの縦線。
   *
   * 何本引くか (--ig-n) と1段の幅 (--ig-w) は行ごとに渡ってくる。
   * 線は文字と同じ幅で並べたいので、桁を ch (等幅の1文字ぶん) で測る。
   * 背景は文字の枠 (content-box) から描き始め、行の左右の余白には出さない
   */
  ".cm-indent-guides": {
    backgroundImage:
      "repeating-linear-gradient(to right, var(--indent-guide) 0 1px, transparent 1px var(--ig-w))",
    backgroundSize: "calc(var(--ig-n) * var(--ig-w)) 100%",
    backgroundRepeat: "no-repeat",
    backgroundOrigin: "content-box",
    backgroundClip: "content-box",
  },
  /*
   * カーソルのいるまとまりの線だけ濃くする。
   *
   * 薄い線の上に、その位置 (--ig-a) だけ1本重ねて描く
   */
  ".cm-indent-guides.cm-indent-on": {
    backgroundImage:
      "linear-gradient(var(--indent-guide-on), var(--indent-guide-on)), repeating-linear-gradient(to right, var(--indent-guide) 0 1px, transparent 1px var(--ig-w))",
    backgroundSize: "1px 100%, calc(var(--ig-n) * var(--ig-w)) 100%",
    backgroundPosition: "calc(var(--ig-a) * var(--ig-w)) 0, 0 0",
    backgroundRepeat: "no-repeat, no-repeat",
  },

  /*
   * 括弧の色分け。
   *
   * 深さで色を変える。ここ (テーマ) に書くのは、シンタックスハイライトの
   * 「記号は薄く」より強く効かせるため
   */
  ".cm-bracket-0": { color: "var(--syn-paren-1)" },
  ".cm-bracket-1": { color: "var(--syn-paren-2)" },
  ".cm-bracket-2": { color: "var(--syn-paren-3)" },
  /*
   * 相手のいない括弧 (閉じ忘れ・余った閉じ括弧)。
   *
   * 書いている途中はよく通る状態なので、色を変えるだけにとどめる
   */
  ".cm-bracket-bad": { color: "var(--syn-paren-bad)", fontWeight: "700" },
  // カーソルを括弧に寄せたときに、その相手を囲む
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "rgba(var(--ink), 0.14)",
    outline: "1px solid rgba(var(--ink), 0.28)",
    borderRadius: "2px",
  },
  "&.cm-focused .cm-nonmatchingBracket": {
    color: "var(--syn-paren-bad)",
  },
});

/** SQL専用エディタ (シンタックスハイライト・行番号つき) */
export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(
  {
    value,
    dbType,
    placeholder,
    onChange,
    onRun,
    onRunSelection,
    onFormat,
    onSaveFile,
    onFunctions,
    onFind,
    statements,
    onTarget,
    onSelectionChange,
    onContextMenu,
    schema,
    autocomplete = true,
    autocompleteDelayMs = 100,
    indent,
    memoKey,
  },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** 見た目を控える名前 (エディタを作り直さずに追従させる) */
  const memoKeyRef = useRef(memoKey);
  memoKeyRef.current = memoKey;
  /** 実行した範囲の光を消すタイマー */
  const flashTimer = useRef(0);
  /** 前に知らせた実行対象 (同じなら知らせ直さない) */
  const targetRef = useRef({ index: -1, total: 0 });
  /** 文の範囲 (DB種別の変更でエディタを作り直したときに入れ直す) */
  const spansRef = useRef(statements);
  spansRef.current = statements;
  // 補完は候補を出すたびにrefを読むので、スキーマが変わっても作り直し不要
  const schemaRef = useRef(schema);
  schemaRef.current = schema;
  // 接続先が変わっても補完を作り直さずに済むよう、DBの種類もrefで持つ
  const dbTypeRef = useRef(dbType);
  dbTypeRef.current = dbType;
  /** 設定変更で入れ替えられるよう、補完の拡張は入れ替え可能にしておく */
  const acRef = useRef(new Compartment());
  /** 字下げも設定で変わるので入れ替え可能にしておく */
  const indentRef = useRef(new Compartment());
  /** キー操作から読む字下げ (エディタを作り直さずに追従させる) */
  const indentTextRef = useRef(indentText(indent));
  indentTextRef.current = indentText(indent);
  // コールバックはrefで持ち、エディタの再生成を避ける
  const cbRef = useRef({
    onChange,
    onRun,
    onRunSelection,
    onFormat,
    onSaveFile,
    onFunctions,
    onFind,
    onTarget,
    onSelectionChange,
    onContextMenu,
  });
  cbRef.current = {
    onChange,
    onRun,
    onRunSelection,
    onFormat,
    onSaveFile,
    onFunctions,
    onFind,
    onTarget,
    onSelectionChange,
    onContextMenu,
  };

  useImperativeHandle(ref, () => ({
    getSelectedText() {
      const view = viewRef.current;
      if (!view) return null;
      const { from, to } = view.state.selection.main;
      if (from === to) return null;
      return view.state.doc.sliceString(from, to);
    },
    getCursor() {
      return viewRef.current?.state.selection.main.from ?? 0;
    },
    /**
     * カーソルの位置に差し込む。
     *
     * 直前が空白でなければ、くっつかないように空白を1つ足す
     * (選択しているときは、その範囲を置き換える)
     */
    insertAtCursor(text: string) {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const before = from > 0 ? view.state.doc.sliceString(from - 1, from) : " ";
      const insert = /[\s(,.]/.test(before) ? text : ` ${text}`;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        scrollIntoView: true,
      });
      view.focus();
    },
    flashRange(from: number, to: number) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ effects: flashRangeEffect.of({ from, to }) });
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => {
        viewRef.current?.dispatch({ effects: flashRangeEffect.of(null) });
      }, FLASH_MS);
    },
    getText() {
      return viewRef.current?.state.doc.toString() ?? "";
    },
    getRange() {
      const main = viewRef.current?.state.selection.main;
      return { from: main?.from ?? 0, to: main?.to ?? 0 };
    },
    /**
     * 見つかった所を選んで、そこまで画面を送る。
     *
     * ここで入力位置をエディタへ移すと検索欄から文字が打てなくなるので、
     * 選ぶだけにする (選択は drawSelection が自前で描くので、
     * 入力位置がエディタに無くても見える)
     */
    selectRange(from: number, to: number) {
      viewRef.current?.dispatch({
        selection: { anchor: from, head: to },
        scrollIntoView: true,
      });
    },
    applyChanges(changes) {
      const view = viewRef.current;
      if (!view || changes.length === 0) return;
      const last = changes[changes.length - 1];
      // 置き換え終わりに入力位置を置く (最後に触った所が見えるように)
      const at = last.from + last.insert.length;
      view.dispatch({
        changes,
        selection: { anchor: at },
        scrollIntoView: true,
      });
    },
    replaceSelection(text: string) {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from, head: from + text.length },
        scrollIntoView: true,
      });
      view.focus();
    },
    markFinds(ranges, active) {
      viewRef.current?.dispatch({
        effects: setFindsEffect.of({ ranges, active }),
      });
    },
    focusEditor() {
      viewRef.current?.focus();
    },
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    /*
     * スクロール位置とカーソルを控える (1フレームに1回へ間引く)。
     * 画面を離れたあとは位置を読めないので、離れるときではなく
     * 動かすたびに控えておく
     */
    const saver = rafThrottle((v: EditorView) => {
      const key = memoKeyRef.current;
      if (!key || viewRef.current !== v) return;
      const sel = v.state.selection.main;
      saveEditorView(key, {
        snapshot: v.scrollSnapshot(),
        anchor: sel.anchor,
        head: sel.head,
        docLength: v.state.doc.length,
      });
    });

    const view = new EditorView({
      doc: value,
      parent: host,
      extensions: [
        lineNumbers({ domEventHandlers: { mousedown: selectLineFromGutter } }),
        // 選択の描画を自前で行う。ブラウザ任せだとフォーカスが無いときに
        // 描かれず、検索でヒットした位置が分からなくなる
        drawSelection(),
        // 実行した範囲を短い間だけ光らせる (選択はしない)
        flashField,
        // 検索で見つかった所に色を付ける
        findField,
        // 実行対象になる文に帯を敷く
        spansField,
        EditorView.decorations.compute(
          [spansField, "doc", "selection"],
          targetDecorations
        ),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        indentRef.current.of(indentUnit.of(indentTextRef.current)),
        /*
         * Option (Alt) を押しながらのドラッグで、縦に四角く選ぶ。
         * 選んだ行それぞれにカーソルが立つので、まとめて打ち直せる。
         * 押している間はカーソルの形を変えて、その状態だと分かるようにする
         */
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        crosshairCursor(),
        // 左右に動かしても縦の並びを保つため、狙っている桁を覚えておく
        multiCursorState,
        // 字下げの縦線と、括弧の対の色分け
        indentGuides(),
        bracketColors(dbType),
        bracketMatching(),
        // sql()ではなくlanguageだけ入れる。
        // sql()は予約語の補完候補も一緒に登録してしまうため
        dialectOf(dbType).language,
        closeBrackets(),
        // 候補はエディタの外に出す (枠内だと overflow: hidden で右側が切れる)
        tooltips({ parent: tooltipHost() }),
        acRef.current.of(
          completionExt(
            autocomplete,
            autocompleteDelayMs,
            () => schemaRef.current ?? {},
            () => dbTypeRef.current
          )
        ),
        syntaxHighlighting(highlight),
        editorTheme,
        cmPlaceholder(placeholder),
        EditorView.lineWrapping,
        Prec.highest(
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                cbRef.current.onRun();
                return true;
              },
            },
            {
              // 実行対象の設定にかかわらず、選択部分だけを実行する
              key: "Mod-Shift-Enter",
              run: () => {
                cbRef.current.onRunSelection();
                return true;
              },
            },
            {
              // 整形は右クリックメニューだけだと気づきにくいので、キーでも出す
              key: "Mod-Shift-f",
              run: () => {
                cbRef.current.onFormat();
                return true;
              },
            },
            {
              // ⌘Sは「お気に入りへ保存」なので、ファイルへは⌘⇧Sを使う
              key: "Mod-Shift-s",
              run: () => {
                cbRef.current.onSaveFile();
                return true;
              },
            },
            {
              // 関数の書き方をその場で引く (Help の H)
              key: "Mod-Shift-h",
              run: () => {
                cbRef.current.onFunctions?.();
                return true;
              },
            },
            {
              // エディタの中を探す (置換もここから開く)
              key: "Mod-f",
              run: () => {
                cbRef.current.onFind?.();
                return true;
              },
            },
            {
              key: "Tab",
              run: (v) => {
                // 補完の候補が出ているときはTabで確定する
                if (completionStatus(v.state) !== null) return acceptCompletion(v);
                // 複数行を選んでいるときは、行ごとに字下げする
                // (置き換えにすると選んだSQLが消えてしまう)
                if (spansLines(v)) return indentMore(v);
                v.dispatch(v.state.replaceSelection(indentTextRef.current));
                return true;
              },
              // Shift+Tabは常に逆字下げ (選んでいなくてもその行を戻す)
              shift: indentLess,
            },
          ])
        ),
        keymap.of([
          ...closeBracketsKeymap,
          // 補完が出ている間のEnterは「確定」なので、その後ろに置く
          ...completionKeymap,
          { key: "Enter", run: insertNewlineSmart },
          // 複数カーソルのときの左右 (行をまたがない)。標準より前に置く
          ...multiCursorKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        // 補完を手で開くキー。
        // macOSは⌥+キーが別の文字(´やnbsp)になりキーマップで拾えないため、
        // 物理キー(code)で判定する。⌃SpaceはOSのIME切り替えに取られるので⌥Spaceを使う
        EditorView.domEventHandlers({
          keydown(event, view) {
            if (
              event.code === "Space" &&
              (event.altKey || event.ctrlKey) &&
              !event.metaKey
            ) {
              event.preventDefault();
              startCompletion(view);
              return true;
            }
            return false;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            cbRef.current.onChange(u.state.doc.toString());
          }
          if (u.docChanged || u.selectionSet) saver.run(u.view);
          if (u.selectionSet) {
            cbRef.current.onSelectionChange(!u.state.selection.main.empty);
          }
          // 変わったときだけ伝える (カーソルを動かすたびに親を描き直さない)
          const now = targetAt(u.state);
          const was = targetRef.current;
          if (now.index !== was.index || now.total !== was.total) {
            targetRef.current = now;
            cbRef.current.onTarget?.(now.index, now.total);
          }
        }),
      ],
    });
    viewRef.current = view;
    // 作り直した直後は文の範囲が空なので、今分かっているものを入れておく
    if (spansRef.current?.length) {
      view.dispatch({ effects: setSpansEffect.of(spansRef.current) });
    }
    // 前にこのシートを開いていたときのスクロール位置・カーソルへ戻す
    const saved = memoKeyRef.current
      ? loadEditorView(memoKeyRef.current, view.state.doc.length)
      : undefined;
    if (saved) {
      view.dispatch({
        selection: { anchor: saved.anchor, head: saved.head },
        effects: saved.snapshot as StateEffect<unknown>,
      });
    }
    const onScroll = () => saver.run(view);
    view.scrollDOM.addEventListener("scroll", onScroll);

    /*
     * 選んだ所を右クリックしても、選択が外れないようにする。
     *
     * 何もしないとブラウザがそこへカーソルを移してしまい、
     * 「選択をIN句の形に」のように選んだ文字を使うメニューが
     * 押せなくなってしまう
     */
    const keepSelection = (e: MouseEvent) => {
      if (e.button !== 2) return;
      const sel = view.state.selection.main;
      if (sel.empty) return;
      const at = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (at !== null && at >= sel.from && at <= sel.to) e.preventDefault();
    };
    view.dom.addEventListener("mousedown", keepSelection, { capture: true });

    const handleCtx = (e: MouseEvent) => {
      e.preventDefault();
      cbRef.current.onContextMenu(e.clientX, e.clientY);
    };
    view.dom.addEventListener("contextmenu", handleCtx);

    return () => {
      view.dom.removeEventListener("mousedown", keepSelection, {
        capture: true,
      });
      view.dom.removeEventListener("contextmenu", handleCtx);
      view.scrollDOM.removeEventListener("scroll", onScroll);
      saver.cancel();
      view.destroy();
      viewRef.current = null;
    };
    // dbType変更時のみ作り直す (valueは下のeffectで同期)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbType]);

  // 設定 (入力補完の有効・待ち時間) が変わったら、その拡張だけ入れ替える
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: acRef.current.reconfigure(
        completionExt(
          autocomplete,
          autocompleteDelayMs,
          () => schemaRef.current ?? {},
          () => dbTypeRef.current
        )
      ),
    });
  }, [autocomplete, autocompleteDelayMs]);

  // 字下げの設定が変わったら、その拡張だけ入れ替える
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: indentRef.current.reconfigure(
        indentUnit.of(indentText(indent))
      ),
    });
  }, [indent]);

  // 文の分け方が届いたらエディタへ渡す (帯の位置がここで決まる)
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: setSpansEffect.of(statements ?? []),
    });
  }, [statements]);

  // 外部からのvalue変更 (整形など) をエディタへ反映
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return <div className="sql-cm" ref={hostRef} />;
});
