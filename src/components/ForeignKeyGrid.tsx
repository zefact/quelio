import { useEffect, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { GridColumn, GridRow, ResizableGrid } from "./ResizableGrid";
import type {
  ColumnInfo,
  DbType,
  ForeignKeyChange,
  ForeignKeyInfo,
  ForeignKeySpec,
} from "../types";

interface Props {
  foreignKeys: ForeignKeyInfo[];
  /** このテーブルのカラム (追加フォームの候補) */
  tableColumns: ColumnInfo[];
  /** 定義変更が使えるか (Valkey以外・ビュー以外) */
  canEdit: boolean;
  dbType: DbType;
  /** 編集状態を解除するきっかけ (テーブル切替時に変わる) */
  resetKey: string | number;
  /** 変更を実行する。失敗したら例外を投げること */
  onApply: (change: ForeignKeyChange) => Promise<void>;
}

const FK_COLS: GridColumn[] = [
  {
    id: "no",
    label: "No",
    width: 52,
    minWidth: 44,
    align: "right",
    cellClass: "rownum-cell",
    description: "外部キーの通し番号 (行番号)",
  },
  { id: "name", label: "制約名", width: 200, minWidth: 80 },
  { id: "columns", label: "カラム", width: 200, minWidth: 100, wrap: true },
  { id: "ref", label: "参照先", width: 260, minWidth: 120, wrap: true },
  {
    id: "onDelete",
    label: "ON DELETE",
    width: 110,
    minWidth: 70,
    description: "参照先の行が消えたときの動き (空欄はDBの既定 = NO ACTION)",
  },
  {
    id: "onUpdate",
    label: "ON UPDATE",
    width: 110,
    minWidth: 70,
    description: "参照先のキーが変わったときの動き (空欄はDBの既定 = NO ACTION)",
  },
];

/** 指定できる動作 (空欄はDBの既定) */
const ACTIONS = ["", "CASCADE", "RESTRICT", "SET NULL", "NO ACTION", "SET DEFAULT"];

/** 空の入力内容 */
function emptyDraft(): ForeignKeySpec {
  return {
    name: "",
    columns: [""],
    refSchema: "",
    refTable: "",
    refColumns: [""],
    onDelete: "",
    onUpdate: "",
  };
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 外部キーの一覧と、追加・削除。
 *
 * 定義の書き換えはどのDBでもできないため、追加と削除だけを扱う。
 * SQLiteは後から付け外しできないので、一覧表示だけにする
 */
export function ForeignKeyGrid({
  foreignKeys,
  tableColumns,
  canEdit,
  dbType,
  resetKey,
  onApply,
}: Props) {
  const [draft, setDraft] = useState<ForeignKeySpec | null>(null);
  const [dropping, setDropping] = useState<ForeignKeyInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // SQLiteはCREATE TABLEに書く以外の方法が無い
  const canChange = canEdit && dbType !== "sqlite" && dbType !== "valkey";

  // テーブルが変わったら入力中の内容を捨てる
  useEffect(() => {
    setDraft(null);
    setDropping(null);
    setError(null);
  }, [resetKey]);

  const run = async (change: ForeignKeyChange, onOk: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await onApply(change);
      onOk();
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const rows: GridRow[] = foreignKeys.map((fk, i) => ({
    key: fk.name || String(i),
    cells: [
      <span className="mono row-num">{i + 1}</span>,
      <span className="mono">{fk.name}</span>,
      <span className="mono">{fk.columns.join(", ")}</span>,
      <span className="mono">
        {(fk.refSchema ? `${fk.refSchema}.` : "") + fk.refTable} (
        {fk.refColumns.join(", ")})
      </span>,
      <span className="mono">{fk.onDelete}</span>,
      <span className="mono">{fk.onUpdate}</span>,
    ],
  }));

  /** 入力欄の1行 (カラム名の候補付き) */
  const columnInput = (
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
    listId?: string
  ) => (
    <input
      className="fk-input mono"
      value={value}
      list={listId}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  );

  return (
    <>
      <h3 className="structure-heading">
        外部キー <span className="panel-count">{foreignKeys.length}</span>
        {canEdit && (
          <>
            <span className="toolbar-spacer" />
            <span className="ddl-hint">
              {dbType === "sqlite"
                ? "SQLiteは後から付け外しできません (表示のみ)"
                : "右クリックで削除"}
            </span>
            {canChange && (
              <button
                className="btn-secondary ddl-add-btn"
                onClick={() => {
                  setError(null);
                  setDraft(emptyDraft());
                }}
                disabled={!!draft}
              >
                <PlusIcon />
                外部キー追加
              </button>
            )}
          </>
        )}
      </h3>

      {(busy || error) && (
        <div className="ddl-bar">
          {busy ? (
            <>
              <span className="spinner accent" />
              <span className="ddl-bar-text">実行中...</span>
            </>
          ) : (
            <>
              <span className="ddl-bar-icon ng" aria-hidden>
                !
              </span>
              <span className="ddl-bar-text ng">{error}</span>
              <span className="toolbar-spacer" />
              <button className="ddl-bar-btn" onClick={() => setError(null)}>
                閉じる
              </button>
            </>
          )}
        </div>
      )}

      <ResizableGrid
        autoFit
        animateRows
        selectable
        columns={FK_COLS}
        emptyText="外部キーがありません"
        rows={rows}
        rowMenuHead={(key) => key}
        rowMenuItems={(key) => {
          if (!canChange || busy) return [];
          const fk = foreignKeys.find((f, i) => (f.name || String(i)) === key);
          if (!fk) return [];
          return [
            {
              label: "この外部キーを削除",
              danger: true,
              onSelect: () => setDropping(fk),
            },
          ];
        }}
      />

      {draft && (
        <div className="fk-form">
          <datalist id="fk-column-options">
            {tableColumns.map((c) => (
              <option key={c.name} value={c.name} />
            ))}
          </datalist>
          <div className="fk-row">
            <label className="fk-field">
              <span className="fk-label">制約名 (空欄ならDBに任せる)</span>
              {columnInput(
                draft.name ?? "",
                (v) => setDraft({ ...draft, name: v }),
                "例: fk_orders_user"
              )}
            </label>
            <label className="fk-field">
              <span className="fk-label">このテーブルのカラム</span>
              {columnInput(
                draft.columns.join(", "),
                (v) =>
                  setDraft({ ...draft, columns: v.split(",").map((x) => x.trim()) }),
                "例: user_id",
                "fk-column-options"
              )}
            </label>
          </div>
          <div className="fk-row">
            <label className="fk-field">
              <span className="fk-label">
                参照先のテーブル
                {dbType === "postgresql" && " (別スキーマは スキーマ.表 と書く)"}
              </span>
              {columnInput(
                draft.refTable,
                (v) => setDraft({ ...draft, refTable: v }),
                dbType === "postgresql" ? "例: public.users" : "例: users"
              )}
            </label>
            <label className="fk-field">
              <span className="fk-label">参照先のカラム</span>
              {columnInput(
                draft.refColumns.join(", "),
                (v) =>
                  setDraft({
                    ...draft,
                    refColumns: v.split(",").map((x) => x.trim()),
                  }),
                "例: id"
              )}
            </label>
          </div>
          <div className="fk-row">
            <label className="fk-field">
              <span className="fk-label">ON DELETE</span>
              <select
                className="fk-input"
                value={draft.onDelete ?? ""}
                onChange={(e) => setDraft({ ...draft, onDelete: e.target.value })}
              >
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a || "(DBの既定)"}
                  </option>
                ))}
              </select>
            </label>
            <label className="fk-field">
              <span className="fk-label">ON UPDATE</span>
              <select
                className="fk-input"
                value={draft.onUpdate ?? ""}
                onChange={(e) => setDraft({ ...draft, onUpdate: e.target.value })}
              >
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a || "(DBの既定)"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="fk-actions">
            <span className="ddl-hint">
              既に入っているデータが条件を満たさないと、追加は失敗します
            </span>
            <span className="toolbar-spacer" />
            <button
              className="ddl-bar-btn"
              onClick={() => setDraft(null)}
              disabled={busy}
            >
              取り消し
            </button>
            <button
              className="ddl-bar-btn primary"
              disabled={busy}
              onClick={() => {
                // 「スキーマ.表」で書かれていたら分けて渡す
                const at = draft.refTable.indexOf(".");
                const fk =
                  at > 0
                    ? {
                        ...draft,
                        refSchema: draft.refTable.slice(0, at).trim(),
                        refTable: draft.refTable.slice(at + 1).trim(),
                      }
                    : draft;
                void run({ kind: "add", fk }, () => setDraft(null)).catch(
                  () => {}
                );
              }}
            >
              追加
            </button>
          </div>
        </div>
      )}

      {dropping && (
        <ConfirmDialog
          title="外部キーを削除します"
          target={dropping.name}
          confirmLabel="削除する"
          onCancel={() => setDropping(null)}
          onConfirm={() =>
            run({ kind: "drop", name: dropping.name }, () => setDropping(null))
          }
        >
          参照の整合性が保たれなくなります。取り消しはできません
          (同じ内容で作り直すことはできます)。
        </ConfirmDialog>
      )}
    </>
  );
}
