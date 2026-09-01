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
  insertNewlineAndIndent,
} from "@codemirror/commands";
import { MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import {
  HighlightStyle,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, Prec, StateEffect, StateField } from "@codemirror/state";
import type { Command } from "@codemirror/view";
import { setEditorFinder } from "../editorSearch";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
  tooltips,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { DbType, SqlIndent } from "../types";
import { watchCompletionLayout } from "./completionLayout";
import {
  completionCells,
  sqlCompletion,
  type SchemaMap,
} from "./sqlCompletion";

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

/** 親から選択テキストを取得するためのハンドル */
export interface SqlEditorHandle {
  getSelectedText(): string | null;
  /** カーソル位置 (文字数。選択しているときは選択の先頭) */
  getCursor(): number;
  /** 今実行した範囲を短い間だけ光らせる (選択はしない) */
  flashRange(from: number, to: number): void;
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
}

/** 入力補完の拡張 (無効なら何も入れない) */
function completionExt(
  enabled: boolean,
  delayMs: number,
  getSchema: () => SchemaMap
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
    // 候補はテーブル・カラムだけ (予約語は出さない)
    override: [sqlCompletion(getSchema)],
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
  },
  ".cm-activeLine": { backgroundColor: "rgba(var(--ink), 0.035)" },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--text-dim)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgba(99, 102, 241, 0.32) !important",
  },
  ".cm-placeholder": { color: "var(--text-faint)" },
  ".cm-cursor": { borderLeftColor: "var(--accent-2)" },
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
    onSelectionChange,
    onContextMenu,
    schema,
    autocomplete = true,
    autocompleteDelayMs = 100,
    indent,
  },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** 実行した範囲の光を消すタイマー */
  const flashTimer = useRef(0);
  // 補完は候補を出すたびにrefを読むので、スキーマが変わっても作り直し不要
  const schemaRef = useRef(schema);
  schemaRef.current = schema;
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
    onSelectionChange,
    onContextMenu,
  });
  cbRef.current = {
    onChange,
    onRun,
    onRunSelection,
    onFormat,
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
    flashRange(from: number, to: number) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ effects: flashRangeEffect.of({ from, to }) });
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => {
        viewRef.current?.dispatch({ effects: flashRangeEffect.of(null) });
      }, FLASH_MS);
    },
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      doc: value,
      parent: host,
      extensions: [
        lineNumbers(),
        // 選択の描画を自前で行う。ブラウザ任せだとフォーカスが無いときに
        // 描かれず、検索でヒットした位置が分からなくなる
        drawSelection(),
        // 実行した範囲を短い間だけ光らせる (選択はしない)
        flashField,
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        indentRef.current.of(indentUnit.of(indentTextRef.current)),
        // sql()ではなくlanguageだけ入れる。
        // sql()は予約語の補完候補も一緒に登録してしまうため
        dialectOf(dbType).language,
        closeBrackets(),
        // 候補はエディタの外に出す (枠内だと overflow: hidden で右側が切れる)
        tooltips({ parent: tooltipHost() }),
        acRef.current.of(
          completionExt(autocomplete, autocompleteDelayMs, () =>
            schemaRef.current ?? {}
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
              key: "Tab",
              run: (v) => {
                // 補完の候補が出ているときはTabで確定する
                if (completionStatus(v.state) !== null) return acceptCompletion(v);
                v.dispatch(v.state.replaceSelection(indentTextRef.current));
                return true;
              },
            },
          ])
        ),
        keymap.of([
          ...closeBracketsKeymap,
          // 補完が出ている間のEnterは「確定」なので、その後ろに置く
          ...completionKeymap,
          { key: "Enter", run: insertNewlineSmart },
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
          if (u.selectionSet) {
            cbRef.current.onSelectionChange(!u.state.selection.main.empty);
          }
        }),
      ],
    });
    viewRef.current = view;

    /*
     * ページ内検索から呼ばれる本文検索。
     * 画面外の行も対象にし、見つかったら選択してその位置まで送る
     */
    setEditorFinder((query, forward) => {
      const v = viewRef.current;
      if (!v || !query) return false;
      const text = v.state.doc.toString().toLowerCase();
      const q = query.toLowerCase();
      const head = v.state.selection.main;
      let at: number;
      if (forward) {
        at = text.indexOf(q, head.to);
        if (at === -1) at = text.indexOf(q);
      } else {
        at = text.lastIndexOf(q, Math.max(0, head.from - 1));
        if (at === -1) at = text.lastIndexOf(q);
      }
      if (at === -1) return false;
      v.dispatch({
        selection: { anchor: at, head: at + query.length },
        scrollIntoView: true,
      });
      // ここでフォーカスを移すと検索欄から入力が奪われ、
      // 次のEnterがSQLの改行になってしまうので移さない
      return true;
    });

    const handleCtx = (e: MouseEvent) => {
      e.preventDefault();
      cbRef.current.onContextMenu(e.clientX, e.clientY);
    };
    view.dom.addEventListener("contextmenu", handleCtx);

    return () => {
      view.dom.removeEventListener("contextmenu", handleCtx);
      setEditorFinder(null);
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
        completionExt(autocomplete, autocompleteDelayMs, () =>
          schemaRef.current ?? {}
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
