import { SelectMenu } from "../SelectMenu";
import { FIELD_KINDS } from "../../types";
import type { FieldKind, TestDataColumn } from "../../types";

/** 種類の選択肢 (並びは types 側の定義順) */
const KIND_OPTIONS = FIELD_KINDS.map(([value, label]) => ({ value, label }));

interface Props {
  columns: TestDataColumn[];
  /** 値を入れる列 (カラム名) */
  picked: Set<string>;
  /** 選び直した種類 (未指定なら推測のまま) */
  kinds: Record<string, FieldKind>;
  disabled: boolean;
  onToggle: (name: string) => void;
  onChangeKind: (name: string, kind: FieldKind) => void;
}

/**
 * 列ごとに「入れるか」と「何を入れるか」を決める一覧。
 *
 * 自動採番の列と外部キーの列は選び直せない
 * (前者はDBが決め、後者は参照先にある値しか入れられないため)
 */
export function TestDataColumnList({
  columns,
  picked,
  kinds,
  disabled,
  onToggle,
  onChangeKind,
}: Props) {
  if (columns.length === 0) {
    return <div className="routine-empty">カラムがありません</div>;
  }
  return (
    <table className="gen-columns">
      <thead>
        <tr>
          <th className="gen-pick" />
          <th>カラム</th>
          <th>型</th>
          <th>入れる値</th>
        </tr>
      </thead>
      <tbody>
        {columns.map((c) => {
          const fixed = c.auto || !!c.references;
          return (
            <tr key={c.name} className={picked.has(c.name) ? "" : "off"}>
              <td className="gen-pick">
                <input
                  type="checkbox"
                  checked={picked.has(c.name)}
                  disabled={disabled || c.auto}
                  title={
                    c.auto ? "自動採番の列なので値を入れません" : undefined
                  }
                  onChange={() => onToggle(c.name)}
                />
              </td>
              <td>
                <span className="mono">{c.name}</span>
                {c.logical && <span className="gen-logical">{c.logical}</span>}
                {!c.nullable && <span className="gen-tag">必須</span>}
                {c.unique && <span className="gen-tag">一意</span>}
              </td>
              <td className="mono faint">{c.colType}</td>
              <td>
                {c.auto ? (
                  <span className="faint">自動採番 (DBが決めます)</span>
                ) : c.references ? (
                  <span className="faint">
                    参照先 <span className="mono">{c.references}</span> の値から選ぶ
                  </span>
                ) : (
                  <SelectMenu
                    value={kinds[c.name] ?? c.kind}
                    options={KIND_OPTIONS}
                    onChange={(v) => onChangeKind(c.name, v as FieldKind)}
                    disabled={disabled || !picked.has(c.name) || fixed}
                    popFixed
                  />
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
