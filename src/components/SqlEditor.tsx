import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { MySQL, PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import {
  HighlightStyle,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { Prec } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { DbType } from "../types";

/** 親から選択テキストを取得するためのハンドル */
export interface SqlEditorHandle {
  getSelectedText(): string | null;
}

interface Props {
  value: string;
  dbType: DbType;
  placeholder: string;
  onChange: (value: string) => void;
  /** ⌘/Ctrl+Enter */
  onRun: () => void;
  onSelectionChange: (hasSelection: boolean) => void;
  onContextMenu: (x: number, y: number) => void;
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

const MONO = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace';

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
  { value, dbType, placeholder, onChange, onRun, onSelectionChange, onContextMenu },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // コールバックはrefで持ち、エディタの再生成を避ける
  const cbRef = useRef({ onChange, onRun, onSelectionChange, onContextMenu });
  cbRef.current = { onChange, onRun, onSelectionChange, onContextMenu };

  useImperativeHandle(ref, () => ({
    getSelectedText() {
      const view = viewRef.current;
      if (!view) return null;
      const { from, to } = view.state.selection.main;
      if (from === to) return null;
      return view.state.doc.sliceString(from, to);
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
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        indentUnit.of("  "),
        sql({
          dialect:
            dbType === "mysql"
              ? MySQL
              : dbType === "sqlite"
                ? SQLite
                : PostgreSQL,
        }),
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
              key: "Tab",
              run: (v) => {
                v.dispatch(v.state.replaceSelection("  "));
                return true;
              },
            },
          ])
        ),
        keymap.of([...defaultKeymap, ...historyKeymap]),
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

    const handleCtx = (e: MouseEvent) => {
      e.preventDefault();
      cbRef.current.onContextMenu(e.clientX, e.clientY);
    };
    view.dom.addEventListener("contextmenu", handleCtx);

    return () => {
      view.dom.removeEventListener("contextmenu", handleCtx);
      view.destroy();
      viewRef.current = null;
    };
    // dbType変更時のみ作り直す (valueは下のeffectで同期)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbType]);

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
