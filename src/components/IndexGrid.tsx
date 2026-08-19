import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ColumnInfo,
  DbType,
  IndexChange,
  IndexInfo,
  IndexSpec,
} from "../types";
import { IndexColumnsDialog } from "./IndexColumnsDialog";
import { GridColumn, GridRow, ResizableGrid } from "./ResizableGrid";

interface Props {
  indexes: IndexInfo[];
  /** 対象カラムの候補 */
  tableColumns: ColumnInfo[];
  /** 定義変更が使えるか (Valkey以外・ビュー以外) */
  canEdit: boolean;
  dbType: DbType;
  /** 編集状態を解除するきっかけ (テーブル切替時に変わる) */
  resetKey: string | number;
  /** 変更を実行する。失敗したら例外を投げること */
  onApply: (change: IndexChange) => Promise<void>;
}

/** 追加行に使う行キー (既存インデックス名と衝突しない値) */
const NEW_ROW = "__quelio_new_index__";

/** 編集できるセル */
type IndexField = "name" | "unique" | "columns" | "type";

/** ダブルクリックで編集を始められる列 */
const EDITABLE: Record<string, IndexField> = {
  name: "name",
  unique: "unique",
  columns: "columns",
  type: "type",
};

/** DB種別ごとに選べるインデックスの種別 */
const INDEX_TYPES: Record<DbType, string[]> = {
  mysql: ["BTREE", "HASH", "FULLTEXT", "SPATIAL"],
  postgresql: ["btree", "hash", "gist", "gin", "spgist", "brin"],
  // SQLiteに種別の指定は無い
  sqlite: [],
  valkey: [],
};

/** UNIQUEと併用できないMySQLの種別 */
const NO_UNIQUE_TYPES = ["FULLTEXT", "SPATIAL"];

/** 種別の説明 (ヒントに出す) */
const INDEX_TYPE_HELP: Record<DbType, [string, string][]> = {
  mysql: [
    ["BTREE", "既定。等価・範囲・前方一致・並び替えに効く万能型。迷ったらこれ"],
    [
      "HASH",
      "等価比較 (=) 専用で、範囲や並び替えには効かない。MEMORYエンジン向けで、InnoDBでは指定してもBTREEになる",
    ],
    [
      "FULLTEXT",
      "文章の全文検索用 (MATCH ... AGAINST)。CHAR / VARCHAR / TEXT が対象。ユニークにはできない",
    ],
    [
      "SPATIAL",
      "地理・図形データ用のR-tree。GEOMETRY / POINT などの空間データ型かつ NOT NULL が必要。ユニークにはできない",
    ],
  ],
  postgresql: [
    ["btree", "既定。等価・範囲・並び替えに効く万能型。迷ったらこれ"],
    ["hash", "等価比較 (=) 専用。範囲や並び替えには効かない"],
    [
      "gist",
      "「含む・重なる・近い」を扱う汎用の木。図形、範囲型、全文検索などに使う",
    ],
    [
      "gin",
      "1行に複数の値が入る列向け (配列・JSONB・全文検索)。検索は速いが更新は重め",
    ],
    [
      "spgist",
      "空間分割型。点やIPレンジなど、偏りのあるデータをうまく分割できる",
    ],
    [
      "brin",
      "巨大で物理的に並んでいる列向け (時系列など)。ブロック単位で範囲を持つので非常に小さい",
    ],
  ],
  sqlite: [],
  valkey: [],
};

function HelpIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M9.5 9.2a2.6 2.6 0 1 1 3.4 2.5c-.6.2-.9.7-.9 1.3v.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12" cy="17" r="1.1" fill="currentColor" />
    </svg>
  );
}

const INDEX_COLS: GridColumn[] = [
  {
    id: "no",
    label: "No",
    width: 52,
    minWidth: 44,
    align: "right",
    cellClass: "rownum-cell",
    description: "インデックスの通し番号 (行番号)",
  },
  { id: "name", label: "名前", width: 180, minWidth: 80 },
  { id: "unique", label: "ユニーク", width: 70, minWidth: 56, align: "center" },
  { id: "columns", label: "カラム", width: 280, minWidth: 100, wrap: true },
  { id: "type", label: "種別", width: 90, minWidth: 60 },
  { id: "card", label: "カーディナリティ", width: 130, minWidth: 80, align: "right" },
];

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

/** 編集中の状態 (既存の変更 or 新規追加) */
type Editing = {
  /** 変更前のインデックス名 (追加のときは空) */
  key: string;
  field: IndexField;
  draft: IndexSpec;
};

/**
 * カンマ区切りの文字列をカラム名の配列にする。
 * PostgreSQLは "lower(name), id" のような式が入ることがあるため、
 * 括弧・引用符の外にあるカンマだけを区切りとして扱う
 */
function toColumns(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter((c) => c.length > 0);
}

/**
 * インデックス一覧。行をその場で編集して追加・変更・削除する。
 *
 * どのDBもインデックスの定義は書き換えられないため、
 * 変更は「消してから作り直す」形で実行する
 */
export function IndexGrid({
  indexes,
  tableColumns,
  canEdit,
  dbType,
  resetKey,
  onApply,
}: Props) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(
    null
  );
  /** 対象カラムを選ぶダイアログを開いているか */
  const [picking, setPicking] = useState(false);
  /** 種別の説明ポップアップの位置 (画面外へはみ出さないよう上下を切り替える) */
  const [help, setHelp] = useState<{
    x: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);

  // テーブルを切り替えたら編集状態とエラーを解除する
  useEffect(() => {
    setEditing(null);
    setError(null);
    setPicking(false);
  }, [resetKey]);

  // フォーカスが外れていてもEscで取り消せるようにする
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || busy) return;
      // カラム選択ダイアログを開いているときはそちらを閉じるだけにする
      if (picking) return;
      setEditing(null);
      setError(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing, busy, picking]);

  // メニューは外側クリックで閉じる
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  // 種別の説明も外側クリック・Escで閉じる
  useEffect(() => {
    if (!help) return;
    const close = () => setHelp(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setHelp(null);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [help]);

  // 編集対象のセルが変わったらその入力欄へフォーカスを移す
  const focusKey = editing ? `${editing.key}:${editing.field}` : "";
  useEffect(() => {
    if (!focusKey) return;
    const field = focusKey.slice(focusKey.lastIndexOf(":") + 1);
    const el = document.querySelector<HTMLInputElement>(
      `.grid tr.row-editing [data-ifield="${field}"]`
    );
    el?.focus();
    if (el?.type === "text") el.select();
  }, [focusKey]);

  /** 種別を指定できるのはMySQL / PostgreSQLだけ */
  const canIndexType = INDEX_TYPES[dbType].length > 0;

  const patch = (p: Partial<IndexSpec>) =>
    setEditing((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...p } } : cur));

  /**
   * 制約に付随するインデックスを触ろうとしたときの説明。
   * DROP/CREATE INDEXでは操作できないので、理由を出しておく
   */
  const constrainedReason = () =>
    "主キーやUNIQUE制約に付随して自動で作られたインデックスです。\n" +
    (dbType === "sqlite"
      ? "CREATE / DROP INDEX では変更できず、テーブルを作り直す必要があります。"
      : "CREATE / DROP INDEX では変更できません。制約 (テーブル定義) 側の変更が必要です。");

  /** 既存インデックスの編集を始める (別の行を編集中なら何もしない) */
  const startEdit = (ix: IndexInfo, field: IndexField) => {
    if (ix.constrained) {
      // 黙って無反応だと理由が分からないので伝える
      if (!editing) setError(constrainedReason());
      return;
    }
    if (editing && editing.key !== ix.name) return;
    setError(null);
    setEditing((cur) =>
      cur && cur.key === ix.name
        ? { ...cur, field }
        : {
            key: ix.name,
            field,
            draft: {
              name: ix.name,
              unique: ix.unique,
              columns: toColumns(ix.columns),
              indexType: ix.indexType ?? "",
            },
          }
    );
  };

  /** 追加行を出す */
  const startAdd = () => {
    if (editing) return;
    setError(null);
    setEditing({
      key: "",
      field: "name",
      draft: { name: "", unique: false, columns: [], indexType: "" },
    });
  };

  const cancel = () => {
    setEditing(null);
    setError(null);
    setPicking(false);
  };

  /** 入力できていて、かつ実際に変更があるか */
  const changed = (() => {
    if (!editing) return false;
    const d = editing.draft;
    if (!d.name.trim() || d.columns.length === 0) return false;
    if (!editing.key) return true;
    const before = indexes.find((ix) => ix.name === editing.key);
    if (!before) return false;
    return (
      before.name !== d.name.trim() ||
      before.unique !== d.unique ||
      toColumns(before.columns).join(",") !== d.columns.join(",") ||
      (before.indexType ?? "") !== (d.indexType ?? "")
    );
  })();

  /** 入力内容をそのまま実行する (確認は挟まない) */
  const commit = async () => {
    if (!editing || busy) return;
    if (!changed) {
      cancel();
      return;
    }
    const index: IndexSpec = { ...editing.draft, name: editing.draft.name.trim() };
    const change: IndexChange = editing.key
      ? { kind: "modify", before: editing.key, index }
      : { kind: "add", index };
    await run(change, () => setEditing(null));
  };

  /** 変更を実行する共通処理 (失敗したらエラーを出して状態は残す) */
  const run = async (change: IndexChange, onOk?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await onApply(change);
      onOk?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  /** 編集中の行のセル */
  const editCells = (d: IndexSpec, rowNum: string) => [
    <span className="mono row-num">{rowNum}</span>,
    <input
      className="cell-input mono"
      data-ifield="name"
      value={d.name}
      placeholder="インデックス名"
      disabled={busy}
      onKeyDown={onKeyDown}
      onChange={(e) => patch({ name: e.target.value })}
    />,
    <input
      type="checkbox"
      className="cell-check"
      data-ifield="unique"
      checked={d.unique}
      // 全文・空間インデックスはユニークにできない
      disabled={busy || NO_UNIQUE_TYPES.includes(d.indexType ?? "")}
      title={
        NO_UNIQUE_TYPES.includes(d.indexType ?? "")
          ? "この種別ではユニークにできません"
          : d.unique
            ? "ユニーク"
            : "ユニークでない"
      }
      onKeyDown={onKeyDown}
      onChange={(e) => patch({ unique: e.target.checked })}
    />,
    // 複合インデックスは順序が大事なので、ダイアログで順番に選ぶ
    <button
      className={"cell-pick mono" + (d.columns.length === 0 ? " empty" : "")}
      data-ifield="columns"
      disabled={busy}
      title="クリックして対象カラムを選ぶ"
      onKeyDown={onKeyDown}
      onClick={() => setPicking(true)}
    >
      {d.columns.length > 0
        ? d.columns.map((c, n) => `${n + 1}. ${c}`).join("  ")
        : "カラムを選ぶ..."}
    </button>,
    canIndexType ? (
      <select
        className="cell-select mono"
        data-ifield="type"
        value={d.indexType ?? ""}
        disabled={busy}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          const v = e.target.value;
          // ユニークと併用できない種別に変えたらチェックを外す
          patch(
            NO_UNIQUE_TYPES.includes(v)
              ? { indexType: v, unique: false }
              : { indexType: v }
          );
        }}
      >
        <option value="">既定</option>
        {INDEX_TYPES[dbType].map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    ) : (
      <span className="cell-locked">-</span>
    ),
    <span className="cell-locked">-</span>,
  ];

  /** 通常表示の行 */
  const viewCells = (ix: IndexInfo, i: number) => [
    <span className="mono row-num">{i + 1}</span>,
    <span className="mono strong" title={ix.name}>
      {ix.name}
    </span>,
    ix.unique ? <span className="check">✓</span> : null,
    // 複合インデックスは順序が大事なので、番号を振って並びを見せる
    <span className="index-col-list">
      {(() => {
        const cols = toColumns(ix.columns);
        return cols.map((c, n) => (
          <span className="index-col-chip mono" key={`${c}-${n}`} title={c}>
            {cols.length > 1 && <span className="index-col-seq">{n + 1}</span>}
            {c}
          </span>
        ));
      })()}
    </span>,
    <span className="dim">{ix.indexType ?? ""}</span>,
    <span className="mono dim">{ix.cardinality?.toLocaleString() ?? ""}</span>,
  ];

  const editRowClass =
    "row-editing" + (busy ? " busy" : "") + (error ? " has-error" : "");
  const rows: GridRow[] = indexes.map((ix, i) =>
    editing && editing.key === ix.name
      ? {
          key: ix.name,
          className: editRowClass,
          cells: editCells(editing.draft, String(i + 1)),
        }
      : { key: ix.name, cells: viewCells(ix, i) }
  );
  if (editing && !editing.key) {
    rows.push({
      key: NEW_ROW,
      className: `${editRowClass} row-new`,
      cells: editCells(editing.draft, "新規"),
    });
  }

  const menuIndex = menu ? indexes.find((ix) => ix.name === menu.key) : undefined;

  return (
    <>
      <h3 className="structure-heading">
        インデックス <span className="panel-count">{indexes.length}</span>
        {canIndexType && (
          <button
            className="hint-btn"
            title="インデックスの種別について"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const below = window.innerHeight - r.bottom - 12;
              const above = r.top - 12;
              // 下に余白が足りなければボタンの上に出す
              const useBelow = below >= 220 || below >= above;
              setHelp((cur) =>
                cur
                  ? null
                  : {
                      x: Math.max(
                        8,
                        Math.min(r.left, window.innerWidth - 448)
                      ),
                      top: useBelow ? r.bottom + 6 : undefined,
                      bottom: useBelow
                        ? undefined
                        : window.innerHeight - r.top + 6,
                      maxHeight: Math.max(
                        160,
                        (useBelow ? below : above) - 6
                      ),
                    }
              );
            }}
          >
            <HelpIcon />
          </button>
        )}
        {canEdit && (
          <>
            <span className="toolbar-spacer" />
            <span className="ddl-hint">
              {editing
                ? "編集中の行を確定するか取り消すと、他の行を編集できます"
                : "ダブルクリックで編集 / 右クリックで削除"}
            </span>
            <button
              className="btn-secondary ddl-add-btn"
              onClick={startAdd}
              disabled={!!editing}
              title={
                editing ? "編集中の行を確定するか取り消してください" : undefined
              }
            >
              <PlusIcon />
              インデックス追加
            </button>
          </>
        )}
      </h3>

      {(editing || busy || error) && (
        <div className="ddl-bar">
          {busy ? (
            <>
              <span className="spinner accent" />
              <span className="ddl-bar-text">実行中...</span>
            </>
          ) : error ? (
            <>
              <span className="ddl-bar-icon ng" aria-hidden>
                !
              </span>
              <span className="ddl-bar-text ng">{error}</span>
            </>
          ) : (
            <span className="ddl-bar-text">
              <kbd>Enter</kbd> で反映 / <kbd>Esc</kbd> で取り消し
              {!changed && "（変更はまだありません）"}
              {editing?.key && "（作り直しになります）"}
            </span>
          )}
          <span className="toolbar-spacer" />
          {editing ? (
            <>
              <button className="ddl-bar-btn" onClick={cancel} disabled={busy}>
                取り消し
              </button>
              <button
                className="ddl-bar-btn primary"
                onClick={commit}
                disabled={busy || !changed}
              >
                反映
              </button>
            </>
          ) : (
            error && (
              <button className="ddl-bar-btn" onClick={() => setError(null)}>
                閉じる
              </button>
            )
          )}
        </div>
      )}

      <ResizableGrid
        autoFit
        animateRows
        columns={INDEX_COLS}
        emptyText="インデックスがありません"
        rows={rows}
        onCellDoubleClick={
          canEdit
            ? (key, colId) => {
                if (key === NEW_ROW || busy) return;
                const field = EDITABLE[colId];
                if (!field) return;
                if (!canIndexType && field === "type") return;
                const ix = indexes.find((x) => x.name === key);
                if (!ix) return;
                startEdit(ix, field);
                if (field === "columns" && !ix.constrained) setPicking(true);
              }
            : undefined
        }
        onRowContextMenu={
          canEdit
            ? (key, e) => {
                if (key === NEW_ROW || busy || editing) return;
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, key });
              }
            : undefined
        }
      />

      {picking && editing && (
        <IndexColumnsDialog
          columns={tableColumns}
          value={editing.draft.columns}
          onClose={() => setPicking(false)}
          onDecide={(cols) => {
            patch({ columns: cols });
            setPicking(false);
          }}
        />
      )}

      {help &&
        createPortal(
          <div
            className="context-menu index-help"
            style={{
              left: help.x,
              top: help.top,
              bottom: help.bottom,
              maxHeight: help.maxHeight,
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="grid-sort-head">インデックスの種別</div>
            <dl className="index-help-list">
              {INDEX_TYPE_HELP[dbType].map(([name, desc]) => (
                <div key={name}>
                  <dt className="mono">{name}</dt>
                  <dd>{desc}</dd>
                </div>
              ))}
            </dl>
          </div>,
          document.body
        )}

      {menu &&
        menuIndex &&
        createPortal(
          <div
            className="context-menu"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="grid-sort-head mono">{menuIndex.name}</div>
            <button
              className="context-item"
              disabled={menuIndex.constrained}
              title={menuIndex.constrained ? constrainedReason() : undefined}
              onClick={() => {
                setMenu(null);
                startEdit(menuIndex, "name");
              }}
            >
              このインデックスを編集
            </button>
            <button
              className="context-item danger"
              disabled={menuIndex.constrained}
              title={menuIndex.constrained ? constrainedReason() : undefined}
              onClick={() => {
                setMenu(null);
                run({ kind: "drop", name: menuIndex.name });
              }}
            >
              このインデックスを削除
            </button>
          </div>,
          document.body
        )}
    </>
  );
}
