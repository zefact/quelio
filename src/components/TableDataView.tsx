import { memo, useEffect, useMemo, useState } from "react";
import type {
  CellValue,
  ColumnInfo,
  DbType,
  RowCell,
  RowChange,
} from "../types";
import { QUERY_PAGE_SIZE } from "../types";
import type { TableDataPane } from "./panes";
import { CellDetail } from "./CellDetail";
import { clipIndex, clippedRowKeys } from "../cellValue";
import { ConfirmDialog } from "./ConfirmDialog";
import { CellText } from "./CellText";
import {
  GridColumn,
  GridRow,
  ResizableGrid,
  SortDir,
  SortState,
} from "./ResizableGrid";
import {
  useAsyncApply,
  useEscapeCancel,
  useGridFocus,
} from "../hooks/useEditableGrid";

interface Props {
  /** データタブの状態と操作 (上の画面から素通しで渡ってくる) */
  pane: TableDataPane;
  /** 行番号列を表示するか (設定値) */
  showRowNumbers: boolean;
  /** カラム名(小文字) → 論理名・補足・型の説明 (ヘッダのツールチップ用) */
  columnTips: Record<string, string>;
  /** テーブルのカラム定義 (主キーの判定に使う。未取得なら空) */
  tableColumns: ColumnInfo[];
  /** データを編集できるか (ビュー・Valkey以外) */
  canEdit: boolean;
  /** canEditがfalseのときの理由 (画面に出す) */
  editDisabledReason?: string;
  /** INSERT文でコピーするときの表名 (クォート済み) */
  insertTable?: string;
  /** カラム名をDBの書き方でクォートする (INSERT文のコピー用) */
  quoteName?: (name: string) => string;
  /** 接続の種類 (INSERT文の文字列の書き方に使う) */
  dbType?: DbType;
  /** 1行分の変更を実行する。失敗したら例外を投げること */
  onApplyRow: (change: RowChange) => Promise<void>;
  /** 切り詰められたセルの全文を読み直す (主キーで行を特定する) */
  onFetchCell?: (column: string, key: RowCell[]) => Promise<CellValue>;
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
function TableDataViewInner({
  pane,
  showRowNumbers,
  columnTips,
  tableColumns,
  canEdit,
  editDisabledReason,
  insertTable,
  quoteName,
  dbType,
  onApplyRow,
  onFetchCell,
}: Props) {
  const {
    data,
    loading,
    error,
    where,
    onChangeWhere,
    onApplyWhere,
    onReload,
    onPage,
    onSort,
  } = pane;
  const [editing, setEditing] = useState<Editing | null>(null);
  const {
    busy,
    error: editError,
    setError: setEditError,
    run,
    runOrThrow,
  } = useAsyncApply<RowChange>(onApplyRow);
  /** 削除の確認中の行 (データ内の位置) */
  const [deleting, setDeleting] = useState<number | null>(null);
  /** 全文表示中のセル (カラム番号・行・表示中の値) */
  const [cellView, setCellView] = useState<{
    column: number;
    row: number;
    value: string;
  } | null>(null);

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

  /** 主キーの値が揃っていて、行を1つに特定できるか */
  const identifiable =
    pkColumns.length > 0 &&
    !!data &&
    pkColumns.every((p) => dataColumns.includes(p));

  /** 主キーで行を特定できれば編集できる */
  const editable = canEdit && identifiable;

  /** 編集できないときの理由 (何も出ないと壊れているように見えるため) */
  const editHint = editable
    ? null
    : !canEdit
      ? // データに関係なく決まる理由なので、読み込み中でも出す
        (editDisabledReason ?? "この表は編集できません")
      : // 主キーの有無は読み込めるまで判断できないので出さない
        loading || !data
        ? null
        : pkColumns.length === 0
          ? "主キーが無いため、この表からは編集できません (SQLエディタのUPDATE/DELETEをお使いください)"
          : "主キーが表示されていないため編集できません (絞り込みを解除して読み込み直してください)";

  // 取得し直したら編集状態を解除する。
  // 全文表示も、行の位置がずれて別の行を指してしまうので閉じる
  useEffect(() => {
    setEditing(null);
    setEditError(null);
    setCellView(null);
  }, [data, setEditError]);

  // フォーカスが外れていてもEscで編集を取り消せるようにする
  useEscapeCancel(
    !!editing,
    () => {
      setEditing(null);
      setEditError(null);
    },
    { busy }
  );

  // 編集対象のセルへフォーカスを移す
  useGridFocus(editing ? `${editing.row}:${editing.col}` : "", "data-dcol");

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
      // 失敗したら直せるよう、行は編集状態のまま残す
      if (await run({ kind: "insert", values })) setEditing(null);
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
    if (await run({ kind: "update", key, set })) setEditing(null);
  };

  /** 行を削除する (確認ダイアログから呼ばれる。失敗したら例外を投げる) */
  const deleteRow = async (row: number) => {
    if (!data?.rows[row]) return;
    const key: RowCell[] = pkColumns.map((column) => ({
      column,
      value: data.rows[row][dataColumns.indexOf(column)],
    }));
    // 失敗した理由は確認ダイアログ側が出すので、投げ直す
    await runOrThrow({ kind: "delete", key });
    setDeleting(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 日本語入力の変換中のEnter/Escは、確定・取り消しの操作なので拾わない
    if (e.nativeEvent.isComposing) return;
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
        <CellText
          key={i}
          value={v}
          clip={clipAt(index, i)}
          onOpen={(value) => setCellView({ column: i, row: index, value })}
        />
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

  /*
   * 通常表示の行はメモ化しておく。
   * セルを1文字打つたびに1000行ぶんの要素を作り直すのを避けるため、
   * 編集中の1行だけを後から差し替える
   */
  /** 切り詰められたセルを (行, 列) から引く */
  const clipAt = useMemo(() => clipIndex(data?.clipped), [data]);
  /** 切り詰められた値がある行 (コピーの注記に使う) */
  const clippedRows = useMemo(() => clippedRowKeys(data?.clipped), [data]);

  const viewRows: GridRow[] = useMemo(
    () =>
      (data?.rows ?? []).map((cells, index) => ({
        key: String(index),
        cells: viewCells(cells, index),
      })),
    // viewCellsが見ているのはこの3つ (行の中身・行番号の表示・ページ先頭)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, showRowNumbers, offset]
  );

  /*
   * コピー用の元の値 (行キー → 表示している列の並び)。
   * 編集中は入力欄の中身が正なので渡さない (画面から読み取らせる)
   */
  const rowValueOf = useMemo(() => {
    const rows = data?.rows ?? [];
    return (key: string) => {
      const cells = rows[Number(key)];
      if (!cells) return undefined;
      // 行番号の列はコピー対象外なので、位置合わせの空文字を置く
      return showRowNumbers ? ["", ...cells] : cells;
    };
  }, [data, showRowNumbers]);

  const editRowClass =
    "row-editing" + (busy ? " busy" : "") + (editError ? " has-error" : "");
  const rows: GridRow[] = !editing
    ? viewRows
    : typeof editing.row === "number"
      ? // 編集中の1行だけ差し替える
        viewRows.map((r, index) =>
          index === editing.row
            ? { key: r.key, className: editRowClass, cells: editCells(editing) }
            : r
        )
      : // 追加行は末尾に足す (メモ化した配列は書き換えない)
        [
          ...viewRows,
          {
            key: NEW_ROW,
            className: `${editRowClass} row-new`,
            cells: editCells(editing),
          },
        ];

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
            // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
            if (e.nativeEvent.isComposing) return;
            // 取得中は受け付けない (連打すると古い結果が後から表示されうる)
            if (e.key === "Enter" && !loading) onApplyWhere();
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

        {editHint && (
          <span className="edit-hint" title={editHint}>
            <span className="edit-hint-icon" aria-hidden>
              i
            </span>
            {editHint}
          </span>
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
            rowValues={editing ? undefined : rowValueOf}
            clippedRowKeys={clippedRows}
            // まず200行だけ描き、スクロールに合わせて継ぎ足す
            maxRenderRows={200}
            // 追加中の行は末尾にあるので、切り詰めても必ず描く
            pinLastRow={editing?.row === "new"}
            insertTable={insertTable}
            insertColumn={(_, label) => quoteName?.(label) ?? label}
            insertDbType={dbType}
            onCellDoubleClick={
              editable
                ? (key, colId) => {
                    if (key === NEW_ROW || busy || !colId.startsWith("c")) return;
                    startEdit(Number(key), Number(colId.slice(1)));
                  }
                : undefined
            }
            rowMenuItems={(key) => {
              if (!editable || key === NEW_ROW || busy || editing) return [];
              const row = Number(key);
              return [
                { label: "この行を編集", onSelect: () => startEdit(row, 0) },
                {
                  label: "この行を削除",
                  danger: true,
                  onSelect: () => setDeleting(row),
                },
              ];
            }}
          />
        )}
      </div>

      {cellView && (
        <CellDetail
          key={`${cellView.row}:${cellView.column}`}
          column={dataColumns[cellView.column] ?? ""}
          value={cellView.value}
          clip={clipAt(cellView.row, cellView.column)}
          // 主キーの値が全て揃っているときだけ、全文を読み直せる
          onFetchFull={
            onFetchCell && identifiable && data?.rows[cellView.row]
              ? () =>
                  onFetchCell(
                    dataColumns[cellView.column],
                    pkColumns.map((column) => ({
                      column,
                      value:
                        data.rows[cellView.row][dataColumns.indexOf(column)],
                    }))
                  )
              : undefined
          }
          onClose={() => setCellView(null)}
        />
      )}

      {deleting !== null && (
        <ConfirmDialog
          title="1行を削除します"
          target={deleteLabel}
          onCancel={() => setDeleting(null)}
          onConfirm={() => deleteRow(deleting)}
        >
          この行のデータは失われます。取り消しはできません。
        </ConfirmDialog>
      )}
    </div>
  );
}

/*
 * 表の中身は行数×列数ぶんのDOMになるので、
 * 渡された内容が変わっていないときは描き直さない
 * (定義タブ側の状態変化や、上の画面の再描画に付き合わせない)
 */
export const TableDataView = memo(TableDataViewInner);
