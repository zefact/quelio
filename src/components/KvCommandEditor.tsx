import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Prec } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { editorTheme } from "./SqlEditor";

interface Props {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  /** ⌘/Ctrl+Enter */
  onRun: () => void;
}

/** Valkeyコマンド用エディタ (行番号つき。SQLエディタと同じ見た目) */
export function KvCommandEditor({ value, placeholder, onChange, onRun }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // コールバックはrefで持ち、エディタの再生成を避ける
  const cbRef = useRef({ onChange, onRun });
  cbRef.current = { onChange, onRun };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      doc: value,
      parent: host,
      extensions: [
        lineNumbers(),
        // 選択の描画はSQLエディタと同じ方式にそろえる
        drawSelection(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
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
          ])
        ),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            cbRef.current.onChange(u.state.doc.toString());
          }
        }),
      ],
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 初回のみ生成 (valueは下のeffectで同期)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部からのvalue変更 (履歴・保存SQLの反映など) をエディタへ反映
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
}
