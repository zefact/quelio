import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ColumnInfo, QueryResult, RowCell, RowChange } from "../types";
import { QUERY_PAGE_SIZE } from "../types";
import {
  GridColumn,
  GridRow,
  ResizableGrid,
  SortDir,
  SortState,
} from "./ResizableGrid";

interface Props {
  /** 取得済みの1ページぶんのデータ (未取得はnull) */
  data: QueryResult | null;
  loading: boolean;
  error: string | null;
  /** 絞り込み条件 (WHERE句。空なら全件) */
  where: string;
  /** 行番号列を表示するか (設定値) */
  showRowNumbers: boolean;
  /** カラム名(小文字) → 論理名・補足・型の説明 (ヘッダのツールチップ用) */
  columnTips: Record<string, string>;
  /** テーブルのカラム定義 (主キーの判定に使う。未取得なら空) */
  tableColumns: ColumnInfo[];
  /** データを編集できるか (ビュー・Valkey以外) */
  canEdit: boolean;
  /** 1行分の変更を実行する。失敗したら例外を投げること */
  onApplyRow: (change: RowChange) => Promise<void>;
  onChangeWhere: (where: string) => void;
  /** 絞り込みを適用して先頭ページから取得し直す */
  onApplyWhere: () => void;
  /** 表示中のページを取得し直す */
  onReload: () => void;
  onPage: (offset: number) => void;
  onSort: (orderBy: string | null, orderDir: "asc" | "desc") => void;
}

/** 追加行に使う行キー */
const NEW_ROW = "__quelio_new_row__";

/** 編集中の行 (rowはデータ内の位置。追加行は "new") */
type Editing = {
  row: number | "new";
  /** 入力中の文字列 (カラム順) */
  draft: string[];
  /** フォーカスを当てる列 */
  col: number;
};

/** 入力が NULL を表しているか (null / NULL / Null どれでも可) */
function isNullText(text: string): boolean {
  return text.trim().toLowerCase() === "null";
}

/** 入力欄の文字列を、DBへ渡す値に変換する */
function toValue(text: string): string | null {
  return isNullText(text) ? null : text;
}

/** DBの値を入力欄の文字列にする (NULLは "NULL" と書いておく) */
function toText(value: string | null): string {
  return value === null ? "NULL" : value;
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

/** 選択テーブルのデータ表示 (1000件ごとのページング + サーバーサイドソート + 編集) */
export function TableDataView({
  data,
  loading,
  error,
  where,
  showRowNumbers,
  columnTips,
  tableColumns,
  canEdit,
  onApplyRow,
  onChangeWhere,
  onApplyWhere,
  onReload,
  onPage,
  onSort,
}: Props) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /** 削除の確認中の行 (データ内の位置) */
  const [deleting, setDeleting] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: number } | null>(
    null
  );

  /** 主キーのカラム名 (これが無いと行を特定できないので編集させない) */
  const pkColumns = useMemo(
    () => tableColumns.filter((c) => c.key === "PRI").map((c) => c.name),
    [tableColumns]
  );

  /**
   * 表示・編集に使うカラム名。
   * 0件のときは結果にカラム情報が入らないので、テーブル定義のほうを使う
   */
  const dataColumns = useMemo(
    () =>
      data && data.columns.length > 0
        ? data.columns
        : tableColumns.map((c) => c.name),
    [data, tableColumns]
  );

  /** 主キーが全て対象カラムに含まれていれば編集できる */
  const editable =
    canEdit &&
    pkColumns.length > 0 &&
    !!data &&
    pkColumns.every((p) => dataColumns.includes(p));

  // 取得し直したら編集状態を解除する
  useEffect(() => {
    setEditing(null);
    setEditError(null);
  }, [data]);

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

  // フォーカスが外れていてもEscで編集を取り消せるようにする
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || busy) return;
      setEditing(null);
      setEditError(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing, busy]);

  // 編集対象のセルへフォーカスを移す
  const focusKey = editing ? `${editing.row}:${editing.col}` : "";
  useEffect(() => {
    if (!focusKey) return;
    const col = focusKey.slice(focusKey.lastIndexOf(":") + 1);
    const el = document.querySelector<HTMLElement>(
      `.grid tr.row-editing [data-dcol="${col}"]`
    );
    el?.focus();
    // NULL表示のときはspanなのでselectを持たない
    if (el instanceof HTMLInputElement) el.select();
  }, [focusKey]);

  const columns: GridColumn[] = useMemo(() => {
    const cols: GridColumn[] = dataColumns.map((name, i) => ({
      id: `c${i}`,
      label: name,
      width: Math.min(260, Math.max(90, name.length * 10 + 40)),
      minWidth: 60,
      // 定義から読み取った論理名・補足をヘッダのツールチップに出す
      description: columnTips[name.toLowerCase()],
    }));
    if (showRowNumbers && cols.length > 0) {
      // 表示中の最大行番号に合わせて幅を決める
      const maxNum = (data?.offset ?? 0) + (data?.rows.length ?? 0);
      cols.unshift({
        id: "__row",
        label: "行",
        width: Math.max(58, String(maxNum).length * 9 + 36),
        minWidth: 46,
        align: "right",
        cellClass: "rownum-cell",
        sortable: false,
        excludeFromCopy: true,
        description: "行番号 (取得結果の通し番号。データの値ではありません)",
      });
    }
    return cols;
  }, [data, dataColumns, showRowNumbers, columnTips]);

  /** グリッドに表示するソート状態 (サーバーサイドソートの結果をそのまま反映) */
  const sort: SortState | null = useMemo(() => {
    if (!data?.orderBy) return null;
    const idx = dataColumns.indexOf(data.orderBy);
    if (idx < 0) return null;
    return { id: `c${idx}`, dir: data.orderDir === "desc" ? "desc" : "asc" };
  }, [data, dataColumns]);

  /** ヘッダのソートメニューでの選択 (サーバーサイドソートで再取得する) */
  const selectSort = (id: string, dir: SortDir) => {
    if (id === "__row" || loading || !data) return;
    const colName = dataColumns[Number(id.slice(1))];
    if (!colName) return;
    onSort(dir ? colName : null, dir ?? "asc");
  };

  const offset = data?.offset ?? 0;

  /** 列幅の自動フィットをやり直す条件 (取得内容が変わったときだけ測り直す) */
  const fitKey = useMemo(
    () =>
      data
        ? [
            dataColumns.join("␟"),
            data.offset,
            data.rows.length,
            data.orderBy ?? "",
            data.orderDir ?? "",
          ].join("|")
        : "",
    [data, dataColumns]
  );

  /** 指定行の編集を始める */
  const startEdit = (row: number, col: number) => {
    if (!editable || busy || !data?.rows[row]) return;
    if (editing && editing.row !== row) return;
    setEditError(null);
    setEditing((cur) =>
      cur && cur.row === row
        ? { ...cur, col }
        : { row, col, draft: data.rows[row].map(toText) }
    );
  };

  /** 追加行を出す (全カラム未入力 = DBの既定に任せる) */
  const startInsert = () => {
    if (!editable || editing || !data) return;
    setEditError(null);
    setEditing({
      row: "new",
      col: 0,
      draft: dataColumns.map(() => ""),
    });
  };

  const cancel = () => {
    setEditing(null);
    setEditError(null);
  };

  /** 実行して、成功したら編集状態を解除する */
  const run = async (change: RowChange, onOk?: () => void) => {
    setBusy(true);
    setEditError(null);
    try {
      await onApplyRow(change);
      onOk?.();
    } catch (e) {
      setEditError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 変更があるか (追加は1つでも入力があれば実行できる) */
  const changed = (() => {
    if (!editing || !data) return false;
    if (editing.row === "new") return editing.draft.some((v) => v !== "");
    const before = data.rows[editing.row];
    if (!before) return false;
    return editing.draft.some((v, i) => toValue(v) !== before[i]);
  })();

  /** 入力内容をそのままDBへ反映する */
  const commit = async () => {
    if (!editing || !data || busy) return;
    if (!changed) {
      cancel();
      return;
    }
    if (editing.row === "new") {
      const values: RowCell[] = dataColumns
        // 空欄のカラムは送らず、DBの既定 (DEFAULT / 自動採番) に任せる
        .map((column, i) => ({ column, text: editing.draft[i] }))
        .filter((c) => c.text !== "")
        .map((c) => ({ column: c.column, value: toValue(c.text) }));
      await run({ kind: "insert", values }, () => setEditing(null));
      return;
    }
    const before = data.rows[editing.row];
    if (!before) {
      cancel();
      return;
    }
    const key: RowCell[] = pkColumns.map((column) => ({
      column,
      value: before[dataColumns.indexOf(column)],
    }));
    const set: RowCell[] = dataColumns
      .map((column, i) => ({ column, value: toValue(editing.draft[i]) }))
      .filter((c, i) => c.value !== before[i]);
    await run({ kind: "update", key, set }, () => setEditing(null));
  };

  /** 行を削除する (確認ダイアログから呼ばれる) */
  const deleteRow = async (row: number) => {
    if (!data?.rows[row]) return;
    const key: RowCell[] = pkColumns.map((column) => ({
      column,
      value: data.rows[row][dataColumns.indexOf(column)],
    }));
    await run({ kind: "delete", key }, () => setDeleting(null));
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

  const patch = (i: number, value: string) =>
    setEditing((cur) =>
      cur
        ? { ...cur, draft: cur.draft.map((v, n) => (n === i ? value : v)) }
        : cur
    );

  /** 編集中の行のセル */
  const editCells = (e: Editing) => {
    const nodes = e.draft.map((v, i) => (
      <input
        key={i}
        className={"cell-input mono" + (isNullText(v) ? " is-null" : "")}
        data-dcol={i}
        value={v}
        disabled={busy}
        // 追加行の空欄はDBの既定に任せる
        placeholder={e.row === "new" ? "既定" : ""}
        onKeyDown={onKeyDown}
        onChange={(ev) => patch(i, ev.target.value)}
      />
    ));
    if (showRowNumbers) {
      nodes.unshift(
        <span className="mono row-num" key="__row">
          {e.row === "new" ? "新規" : offset + e.row + 1}
        </span>
      );
    }
    return nodes;
  };

  /** 通常表示の行 */
  const viewCells = (cells: (string | null)[], index: number) => {
    const nodes = cells.map((v, i) =>
      v === null ? (
        <span className="null-cell" key={i}>
          NULL
        </span>
      ) : (
        <span className="mono" title={v} key={i}>
          {v}
        </span>
      )
    );
    if (showRowNumbers) {
      nodes.unshift(
        <span className="mono row-num" key="__row">
          {offset + index + 1}
        </span>
      );
    }
    return nodes;
  };

  const editRowClass =
    "row-editing" + (busy ? " busy" : "") + (editError ? " has-error" : "");
  const rows: GridRow[] = (data?.rows ?? []).map((cells, index) =>
    editing && editing.row === index
      ? { key: String(index), className: editRowClass, cells: editCells(editing) }
      : { key: String(index), cells: viewCells(cells, index) }
  );
  if (editing && editing.row === "new") {
    rows.push({
      key: NEW_ROW,
      className: `${editRowClass} row-new`,
      cells: editCells(editing),
    });
  }

  /** 削除確認に出す行の説明 (主キーの値) */
  const deleteLabel =
    deleting !== null && data?.rows[deleting]
      ? pkColumns
          .map(
            (c) =>
              `${c} = ${data.rows[deleting][dataColumns.indexOf(c)] ?? "NULL"}`
          )
          .join(", ")
      : "";

  return (
    <div className="table-data">
      {/* 絞り込み + ページ操作 */}
      <div className="query-actions table-data-actions">
        <input
          className="filter-input mono table-where"
          placeholder="絞り込み条件 (WHERE句。例: status = 1 AND name LIKE '%山%')"
          value={where}
          onChange={(e) => onChangeWhere(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onApplyWhere();
          }}
        />
        <button
          className="btn-primary"
          onClick={onApplyWhere}
          disabled={loading}
          title="条件を適用して先頭ページから取得し直す (Enter)"
        >
          {loading ? (
            <>
              <span className="spinner light" /> 取得中...
            </>
          ) : (
            "適用"
          )}
        </button>
        <button
          className="btn-secondary explain-btn"
          onClick={onReload}
          disabled={loading}
          title="表示中のページを取得し直す"
        >
          再読込
        </button>
        {editable && (
          <button
            className="btn-secondary ddl-add-btn"
            onClick={startInsert}
            disabled={loading || !!editing}
            title={
              editing ? "編集中の行を確定するか取り消してください" : undefined
            }
          >
            <PlusIcon />
            行を追加
          </button>
        )}

        {!loading && data && (
          <span className="query-meta mono">
            {data.rows.length === 0
              ? "0行"
              : `${(offset + 1).toLocaleString()}〜${(
                  offset + data.rows.length
                ).toLocaleString()}行目`}
            {` — ${data.elapsedMs}ms`}
          </span>
        )}

        {data && (offset > 0 || data.hasMore) && (
          <span className="pager">
            <button
              className="pager-btn"
              title="前の1000行"
              disabled={loading || offset === 0}
              onClick={() => onPage(Math.max(0, offset - QUERY_PAGE_SIZE))}
            >
              ‹
            </button>
            <button
              className="pager-btn"
              title="次の1000行"
              disabled={loading || !data.hasMore}
              onClick={() => onPage(offset + QUERY_PAGE_SIZE)}
            >
              ›
            </button>
          </span>
        )}
      </div>

      {error && (
        <div className="result-banner ng query-error">
          <span className="dot" aria-hidden />
          <strong>エラー</strong>
          <span className="result-detail">{error}</span>
        </div>
      )}

      {/* 編集の案内と、実行中・エラーの表示 */}
      {(editing || busy || editError) && (
        <div className="ddl-bar">
          {busy ? (
            <>
              <span className="spinner accent" />
              <span className="ddl-bar-text">実行中...</span>
            </>
          ) : editError ? (
            <>
              <span className="ddl-bar-icon ng" aria-hidden>
                !
              </span>
              <span className="ddl-bar-text ng">{editError}</span>
            </>
          ) : (
            <span className="ddl-bar-text">
              <kbd>Enter</kbd> で反映 / <kbd>Esc</kbd> で取り消し
              {" — null と入力するとNULL"}
              {!changed && "（変更はまだありません）"}
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
            editError && (
              <button
                className="ddl-bar-btn"
                onClick={() => setEditError(null)}
              >
                閉じる
              </button>
            )
          )}
        </div>
      )}

      <div className="table-data-grid">
        {loading && !data ? (
          <div className="content-placeholder dim-center">
            <span className="spinner accent" /> データを読み込み中...
          </div>
        ) : !data ? (
          !error && (
            <div className="content-placeholder dim-center">
              データがありません
            </div>
          )
        ) : data.rows.length === 0 && !editing ? (
          <div className="content-placeholder dim-center">
            該当するデータはありません
          </div>
        ) : (
          <ResizableGrid
            autoFit
            fitKey={fitKey}
            // 編集中は行選択のショートカット (⌘A/⌘C) が入力の邪魔になるので切る
            selectable={!editing}
            columns={columns}
            sort={sort}
            onSortSelect={selectSort}
            rows={rows}
            onCellDoubleClick={
              editable
                ? (key, colId) => {
                    if (key === NEW_ROW || busy || !colId.startsWith("c")) return;
                    startEdit(Number(key), Number(colId.slice(1)));
                  }
                : undefined
            }
            onRowContextMenu={
              editable
                ? (key, e) => {
                    if (key === NEW_ROW || busy || editing) return;
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, row: Number(key) });
                  }
                : undefined
            }
          />
        )}
      </div>

      {menu &&
        createPortal(
          <div
            className="context-menu"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="context-item"
              onClick={() => {
                const row = menu.row;
                setMenu(null);
                startEdit(row, 0);
              }}
            >
              この行を編集
            </button>
            <button
              className="context-item danger"
              onClick={() => {
                const row = menu.row;
                setMenu(null);
                setDeleting(row);
              }}
            >
              この行を削除
            </button>
          </div>,
          document.body
        )}

      {deleting !== null && (
        <div className="modal-overlay" onMouseDown={() => setDeleting(null)}>
          <div
            className="modal ddl-confirm"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === "Escape" && setDeleting(null)}
            tabIndex={-1}
            ref={(el) => el?.focus()}
          >
            <div className="modal-head">
              <span className="modal-title">1行を削除します</span>
              <button
                className="modal-close"
                onClick={() => setDeleting(null)}
                title="閉じる"
              >
                ×
              </button>
            </div>
            <div className="column-modal-body">
              <p className="column-warn">
                この行のデータは失われます。取り消しはできません。
              </p>
              <p className="column-note">対象の行</p>
              <pre className="column-sql mono">{deleteLabel}</pre>
              {editError && (
                <div className="result-banner ng column-error">
                  <span className="dot" aria-hidden />
                  <strong>エラー</strong>
                  <span className="result-detail">{editError}</span>
                </div>
              )}
            </div>
            <div className="modal-actions column-modal-actions">
              <span className="toolbar-spacer" />
              <button
                className="btn-secondary"
                onClick={() => setDeleting(null)}
                disabled={busy}
              >
                キャンセル
              </button>
              <button
                className="btn-danger"
                disabled={busy}
                onClick={() => deleteRow(deleting)}
              >
                {busy ? (
                  <>
                    <span className="spinner light" /> 実行中...
                  </>
                ) : (
                  "削除する"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
