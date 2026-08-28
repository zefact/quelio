import { SelectMenu } from "../SelectMenu";
import type { DbType } from "../../types";
import {
  DraftColumn,
  moveColumn,
  newColumn,
  patchColumn,
} from "./newTable";

interface Props {
  dbType: DbType;
  columns: DraftColumn[];
  /** そのサーバーで使える型名 */
  types: string[];
  disabled: boolean;
  onChange: (columns: DraftColumn[]) => void;
}

/** 上下と削除のボタンの中身 */
function Arrow({ up }: { up: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d={up ? "M12 19V5m0 0-6 6m6-6 6 6" : "M12 5v14m0 0 6-6m-6 6-6-6"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * カラムを並べて入れる表。
 *
 * 型は打ち間違えやすいので候補から選ばせ、長さや列挙の値だけを別の欄で受ける
 * (varchar + 100 → varchar(100))
 */
export function ColumnRows({
  dbType,
  columns,
  types,
  disabled,
  onChange,
}: Props) {
  // コメントを持てないDBでは、その列ごと出さない
  const withComment = dbType === "mysql" || dbType === "postgresql";

  const typeOptions = (current: string) => {
    const list = types.map((t) => ({ value: t, label: t }));
    // 一覧に無い型 (サーバーから取れなかった場合など) も選択済みとして出す
    return current && !types.includes(current)
      ? [{ value: current, label: current }, ...list]
      : list;
  };

  const patch = (id: string, p: Partial<DraftColumn>) =>
    onChange(patchColumn(columns, id, p));

  /** 最後の行に入力が入ったら、次の空行を足しておく */
  const withSpare = (next: DraftColumn[]) => {
    const last = next[next.length - 1];
    return last && (last.name.trim() || last.type.trim())
      ? [...next, newColumn()]
      : next;
  };

  return (
    <div className={"ct-grid" + (withComment ? "" : " no-comment")}>
      <div className="ct-head">
        <span>カラム名</span>
        <span>型</span>
        <span className="ct-th-args">長さ・値</span>
        <span className="ct-th-check">NULL可</span>
        <span className="ct-th-check">主キー</span>
        <span className="ct-th-check">自動採番</span>
        <span>デフォルト</span>
        {withComment && <span>コメント</span>}
        <span />
      </div>

      {columns.map((c, i) => (
        <div className="ct-row" key={c.id}>
          <input
            className="text-field mono"
            value={c.name}
            spellCheck={false}
            disabled={disabled}
            placeholder="名前"
            onChange={(e) =>
              onChange(withSpare(patchColumn(columns, c.id, { name: e.target.value })))
            }
          />
          <SelectMenu
            className="select-field mono"
            value={c.type}
            options={typeOptions(c.type)}
            disabled={disabled}
            placeholder="型を選ぶ"
            popFixed
            onChange={(v) =>
              onChange(withSpare(patchColumn(columns, c.id, { type: v })))
            }
          />
          <input
            className="text-field mono ct-args"
            value={c.args}
            spellCheck={false}
            disabled={disabled}
            placeholder="100"
            title="括弧の中に書く指定 (varcharの長さ、numericの精度、enumの値など)"
            onChange={(e) => patch(c.id, { args: e.target.value })}
          />
          <label className="ct-check">
            <input
              type="checkbox"
              checked={c.nullable}
              disabled={disabled}
              onChange={(e) => patch(c.id, { nullable: e.target.checked })}
            />
          </label>
          <label className="ct-check">
            <input
              type="checkbox"
              checked={c.primaryKey}
              disabled={disabled}
              onChange={(e) => patch(c.id, { primaryKey: e.target.checked })}
            />
          </label>
          <label className="ct-check">
            <input
              type="checkbox"
              checked={c.autoIncrement}
              disabled={disabled}
              title="主キーの整数カラムを自動で採番します"
              onChange={(e) => patch(c.id, { autoIncrement: e.target.checked })}
            />
          </label>
          <input
            className="text-field mono"
            value={c.default}
            spellCheck={false}
            disabled={disabled}
            placeholder="例: 0"
            title="デフォルト値の式 (0 や 'unknown'、CURRENT_TIMESTAMP など)"
            onChange={(e) => patch(c.id, { default: e.target.value })}
          />
          {withComment && (
            <input
              className="text-field"
              value={c.comment}
              disabled={disabled}
              placeholder="説明"
              onChange={(e) => patch(c.id, { comment: e.target.value })}
            />
          )}
          <div className="ct-ops">
            <button
              className="ct-op-btn"
              disabled={disabled || i === 0}
              title="上へ"
              onClick={() => onChange(moveColumn(columns, i, -1))}
            >
              <Arrow up />
            </button>
            <button
              className="ct-op-btn"
              disabled={disabled || i === columns.length - 1}
              title="下へ"
              onClick={() => onChange(moveColumn(columns, i, 1))}
            >
              <Arrow up={false} />
            </button>
            <button
              className="ct-op-btn danger"
              // 全部消せてしまうと足す手立てが無くなるので、1行は残す
              disabled={disabled || columns.length === 1}
              title="この行を消す"
              onClick={() => onChange(columns.filter((x) => x.id !== c.id))}
            >
              ×
            </button>
          </div>
        </div>
      ))}

      <div className="ct-add">
        <button
          className="btn-ghost"
          disabled={disabled}
          onClick={() => onChange([...columns, newColumn()])}
        >
          ＋ カラムを足す
        </button>
      </div>
    </div>
  );
}
