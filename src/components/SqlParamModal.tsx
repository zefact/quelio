import { useState } from "react";
import { PARAM_KINDS, ParamKind, ParamValue } from "../sqlParams";
import { SelectMenu } from "./SelectMenu";

interface Props {
  /** パラメータ名 (SQL中の出現順) */
  params: string[];
  /** 前回使用した値・スキーマから推測した型などの初期値 */
  initial: Record<string, ParamValue>;
  onCancel: () => void;
  onSubmit: (values: Record<string, ParamValue>) => void;
}

/** SQL実行前のパラメータ入力モーダル */
export function SqlParamModal({ params, initial, onCancel, onSubmit }: Props) {
  const [values, setValues] = useState<Record<string, ParamValue>>(() => ({
    ...initial,
  }));

  const set = (name: string, patch: Partial<ParamValue>) =>
    setValues((prev) => {
      const cur = prev[name] ?? { value: "", kind: "auto" as ParamKind };
      return { ...prev, [name]: { ...cur, ...patch } };
    });

  const submit = () => onSubmit(values);

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div
        className="modal sqlp-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      >
        <div className="modal-head">
          <span className="modal-title">パラメータの入力</span>
          <button className="modal-close" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="sqlp-grid">
          {params.map((p, i) => {
            const v = values[p] ?? { value: "", kind: "auto" as ParamKind };
            return (
              <div className="sqlp-row" key={p}>
                <span className="sqlp-name mono" title={p}>
                  {p}
                </span>
                <input
                  className="mono"
                  value={v.value}
                  autoFocus={i === 0}
                  onChange={(e) => set(p, { value: e.target.value })}
                />
                <div className="sqlp-kind">
                  <SelectMenu
                    value={v.kind}
                    popFixed
                    options={PARAM_KINDS.map(([kind, label]) => ({
                      value: kind,
                      label,
                    }))}
                    onChange={(kind) => set(p, { kind: kind as ParamKind })}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div className="sqlp-hint">
          型はカラム定義から自動判定されます (右のプルダウンで変更可能)。
          「文字列」は常に ' ' 付き、「数値」「そのまま」は入力どおりに
          埋め込まれます。値と型は保存され、次回から初期値になります。
        </div>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel}>
            キャンセル
          </button>
          <button className="btn-primary" onClick={submit}>
            実行
          </button>
        </div>
      </div>
    </div>
  );
}
