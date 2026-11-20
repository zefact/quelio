import { memo, useEffect, useMemo, useRef, useState } from "react";
import type {
  CellValue,
  ColumnInfo,
  DbType,
  HeaderLabelMode,
  RowCell,
  RowChange,
} from "../types";
import type { TableDataPane } from "./panes";
import { CellDetail } from "./CellDetail";
import { WhereBuilder } from "./WhereBuilder";
import { initialConds } from "../whereBuilder";
import type { FilterCond } from "../whereBuilder";
import { recallBuilt, rememberBuilt } from "../tableFilterStore";
import { clipIndex, clippedRowKeys } from "../cellValue";
import { columnKinds, kindAlign, kindClass } from "../cellKind";
import { ConfirmDialog } from "./ConfirmDialog";
import { EditBar, EditKeysHint } from "./EditBar";
import { IconButton } from "./IconButton";
import { useAskConfirm } from "../hooks/useAskConfirm";
import { rowChangeText } from "../prodConfirm";
import type { RowChangeKind } from "../prodConfirm";
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
import { ResultBar } from "./ResultBar";
import { headerText, headerWidth } from "../headerLabel";
import { imeBusy } from "../ime";

interface Props {
  /** データタブの状態と操作 (上の画面から素通しで渡ってくる) */
  pane: TableDataPane;
  /** 行番号列を表示するか (設定値) */
  showRowNumbers: boolean;
  /** カラム名(小文字) → 日本語名・補足・型の説明 (ヘッダのツールチップ用) */
  columnTips: Record<string, string>;
  /** カラム名(小文字) → 日本語名 (ヘッダに出す名前用) */
  columnLabels: Record<string, string>;
  /** ヘッダに出す名前 (英語名 / 日本語名 / 両方) */
  headerMode: HeaderLabelMode;
  onChangeHeaderMode: (mode: HeaderLabelMode) => void;
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
  /** 接続の種類 (INSERT文の書き方と、条件を作るときの引用の要否に使う) */
  dbType: DbType;
  /** 本番の接続か (更新の確定前に確認を挟む) */
  prod?: boolean;
  /** 確認に出すテーブル名 (スキーマがあれば付けた形) */
  tableLabel?: string;
  /**
   * 1行分の変更を実行する。失敗したら例外を投げること。
   * `confirmed` は本番の確認を経たか (本番では入口で確かめられる)
   */
  onApplyRow: (change: RowChange, confirmed: boolean) => Promise<void>;
  /** 切り詰められたセルの全文を読み直す (主キーで行を特定する) */
  onFetchCell?: (column: string, key: RowCell[]) => Promise<CellValue>;
  /**
   * 「条件を作る」で作った条件を覚えておく場所 (接続タブ・DB・テーブル)。
   * 開き直したときに前の条件を並べ直すのに使う
   */
  filterSlot?: { session: string; database: string; table: string };
  /**
   * 行の編集を始めた・終えたときに呼ばれる。
   * 編集中は上の画面の「再読み込み」を押せなくする (押すと入力が消えるため)
   */
  onEditingChange?: (editing: boolean) => void;
}

/**
 * 1回の確定で送るもの。
 *
 * 本番では画面の確認を経たかどうかもバックエンドに渡す
 * (画面の作りを変えたときに確認が黙って外れないよう、入口でも見ている)
 */
type RowApply = { change: RowChange; confirmed: boolean };

/** 追加行に使う行キー */
const NEW_ROW = "__quelio_new_row__";

/** 編集中の行 (rowはデータ内の位置。追加行は "new") */
type Editing = {
  row: number | "new";
  /**
   * 入力中の値 (カラム順)。null は NULL。
   *
   * NULL は文字で打たせず、「NULL にする」で入れる。
   * 「null と打てば NULL」にしていたころは、文字の "NULL" を入れられなかった
   */
  draft: (string | null)[];
  /** フォーカスを当てる列 */
  col: number;
};

/** 行の編集中に押せないボタンの理由 (押すと入力が消えるもの) */
const EDITING_LOCK = "編集中の行があります。保存するか破棄してください";

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
  columnLabels,
  headerMode,
  onChangeHeaderMode,
  tableColumns,
  canEdit,
  editDisabledReason,
  insertTable,
  quoteName,
  dbType,
  prod = false,
  tableLabel = "",
  onApplyRow,
  onFetchCell,
  filterSlot,
  onEditingChange,
}: Props) {
  const {
    data,
    loading,
    error,
    where,
    appliedWhere,
    fetchedAt,
    onChangeWhere,
    onApplyWhere,
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
  } = useAsyncApply<RowApply>((p) => onApplyRow(p.change, p.confirmed));
  /** 削除の確認中の行 (データ内の位置) */
  const [deleting, setDeleting] = useState<number | null>(null);
  /**
   * 本番で確定を押したあとの確認待ち。
   *
   * セルごとではなく「確定1回につき1回」出す。
   * 1セルずつ確認を出すと、内容を読まずに押す操作になってしまう
   */
  const [confirmRow, setConfirmRow] = useState<RowChangeKind | null>(null);
  /**
   * 条件を組み立てる画面。
   * openのときだけ出し、列ヘッダから開いたときはその列を選んでおく
   */
  const [building, setBuilding] = useState<{ column?: string } | null>(null);
  /** 絞り込み条件の入力欄 (消したあとに入力を続けられるよう戻す先) */
  const whereRef = useRef<HTMLInputElement>(null);
  /** この画面の外枠 (Esc で編集を取り消すのは、フォーカスがこの中にあるときだけ) */
  const rootRef = useRef<HTMLDivElement>(null);
  /** 最後にフォーカスがあった入力欄の列 (「NULL にする」の対象) */
  const focusCol = useRef(0);
  /** 手で書いた条件を「条件を作る」で置き換える前の確認 */
  const [ask, askDialog] = useAskConfirm();
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
  /** 列名 → 型 (条件を組み立てるとき、値に引用符を付けるかの判断に使う) */
  const columnTypes = useMemo(
    () => Object.fromEntries(tableColumns.map((c) => [c.name, c.colType])),
    [tableColumns]
  );

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

  /*
   * 入力欄からフォーカスが外れていても、この画面の中なら Esc で編集を取り消す。
   * 画面の外 (SQLエディタなど) で押した Esc では消さない
   */
  useEscapeCancel(
    !!editing,
    () => {
      setEditing(null);
      setEditError(null);
    },
    { busy, scope: rootRef }
  );

  // 編集中かどうかを上の画面へ伝える (この画面が消えるときは「編集していない」に戻す)
  const isEditing = !!editing;
  useEffect(() => {
    onEditingChange?.(isEditing);
  }, [isEditing, onEditingChange]);
  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);

  /** 押すと入力中の行が消える操作を止める理由 (編集していなければ null) */
  const lockReason = editing ? EDITING_LOCK : null;
  /**
   * 画面の条件が、今見ているデータの条件と違うか (まだ適用していない)。
   * 適用済みの条件を持っていない (古い状態から戻した) ときは比べない
   */
  const whereDirty =
    !!data && appliedWhere !== undefined && where.trim() !== appliedWhere.trim();

  // 編集対象のセルへフォーカスを移す
  useGridFocus(editing ? `${editing.row}:${editing.col}` : "", "data-dcol");

  /** 表示中のページの値から見分けた列の種類 (右寄せ・色に使う) */
  const colKinds = useMemo(
    () => columnKinds(data?.rows ?? [], dataColumns.length),
    [data, dataColumns]
  );

  const columns: GridColumn[] = useMemo(() => {
    const cols: GridColumn[] = dataColumns.map((name, i) => {
      const head = headerText(name, columnLabels[name.toLowerCase()], headerMode);
      return {
        id: `c${i}`,
        label: head.main,
        // INSERT文はDBのカラム名で組み立てる
        name,
        subLabel: head.sub,
        labelJa: head.mainJa,
        width: headerWidth(head.main, head.sub),
        minWidth: 60,
        align: kindAlign(colKinds[i] ?? "text"),
        cellClass: kindClass(colKinds[i] ?? "text"),
        // 定義から読み取った日本語名・補足をヘッダのツールチップに出す
        description: columnTips[name.toLowerCase()],
      };
    });
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
  }, [data, dataColumns, showRowNumbers, columnTips, columnLabels, headerMode, colKinds]);

  /** グリッドに表示するソート状態 (サーバーサイドソートの結果をそのまま反映) */
  const sort: SortState | null = useMemo(() => {
    if (!data?.orderBy) return null;
    const idx = dataColumns.indexOf(data.orderBy);
    if (idx < 0) return null;
    return { id: `c${idx}`, dir: data.orderDir === "desc" ? "desc" : "asc" };
  }, [data, dataColumns]);

  /** ヘッダのソートメニューでの選択 (サーバーサイドソートで再取得する) */
  const selectSort = (id: string, dir: SortDir) => {
    // 編集中に並べ替えると取り直しで入力が消えるので受け付けない
    if (id === "__row" || loading || !data || editing) return;
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
            // ヘッダの出し方を変えたら、列幅も測り直す (2段になると幅が変わる)
            headerMode,
          ].join("|")
        : "",
    [data, dataColumns, headerMode]
  );

  /** 指定行の編集を始める */
  const startEdit = (row: number, col: number) => {
    if (!editable || busy || !data?.rows[row]) return;
    if (editing && editing.row !== row) return;
    setEditError(null);
    setEditing((cur) =>
      cur && cur.row === row
        ? { ...cur, col }
        : { row, col, draft: [...data.rows[row]] }
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
    return editing.draft.some((v, i) => v !== before[i]);
  })();

  /**
   * 確定を押したときの入口。
   *
   * 本番では、ここで一度止めて確認を出す
   * (取り消せない更新を、画面を見たままの勢いで流さないように)
   */
  const commit = async () => {
    if (!editing || !data || busy) return;
    if (!changed) {
      cancel();
      return;
    }
    if (prod) {
      setConfirmRow(editing.row === "new" ? "insert" : "update");
      return;
    }
    await applyEdit(false);
  };

  /** 入力内容をそのままDBへ反映する (`confirmed` は本番の確認を経たか) */
  const applyEdit = async (confirmed: boolean) => {
    if (!editing || !data || busy) return;
    if (editing.row === "new") {
      const values: RowCell[] = dataColumns
        // 空欄のカラムは送らず、DBの既定 (DEFAULT / 自動採番) に任せる
        .map((column, i) => ({ column, value: editing.draft[i] }))
        .filter((c) => c.value !== "");
      // 失敗したら直せるよう、行は編集状態のまま残す
      if (await run({ change: { kind: "insert", values }, confirmed })) {
        setEditing(null);
      }
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
      .map((column, i) => ({ column, value: editing.draft[i] }))
      .filter((c, i) => c.value !== before[i]);
    if (await run({ change: { kind: "update", key, set }, confirmed })) {
      setEditing(null);
    }
  };

  /**
   * 行を削除する (確認ダイアログから呼ばれる。失敗したら例外を投げる)。
   * ダイアログを通っているので、本番の確認は経ている
   */
  const deleteRow = async (row: number) => {
    if (!data?.rows[row]) return;
    const key: RowCell[] = pkColumns.map((column) => ({
      column,
      value: data.rows[row][dataColumns.indexOf(column)],
    }));
    // 失敗した理由は確認ダイアログ側が出すので、投げ直す
    await runOrThrow({ change: { kind: "delete", key }, confirmed: true });
    setDeleting(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 日本語入力の変換中のEnter/Escは、確定・取り消しの操作なので拾わない
    if (imeBusy(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  const patch = (i: number, value: string | null) =>
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
        className={"cell-input mono has-tooltip" + (v === null ? " is-null" : "")}
        data-dcol={i}
        value={v ?? ""}
        disabled={busy}
        // NULL は空欄に「NULL」と薄く出す。追加行の空欄はDBの既定に任せる
        placeholder={v === null ? "NULL" : e.row === "new" ? "既定" : ""}
        data-tooltip={v === null ? "NULL (文字を打つと値になります)" : undefined}
        onFocus={() => {
          focusCol.current = i;
        }}
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

  /**
   * 組み立てた条件を入力欄へ入れて、そのまま取得し直す。
   * 手で書いた条件が入っているときは、置き換える前に確認する
   */
  const applyBuilt = async (
    built: string,
    conds: FilterCond[]
  ): Promise<boolean> => {
    if (editing) return false;
    const handWritten =
      where.trim() !== "" && where.trim() !== built.trim() && !savedConds();
    if (handWritten) {
      const ok = await ask({
        title: "絞り込み条件を置き換えます",
        confirmLabel: "置き換える",
        body: (
          <>
            入力欄に手で書いた条件があります。作った条件で置き換えると、今の条件は消えます。
            <pre className="mono confirm-sql">{where}</pre>
          </>
        ),
      });
      // やめたら「条件を作る」の画面を開いたままにする
      if (!ok) return false;
    }
    if (filterSlot) {
      rememberBuilt(filterSlot.session, filterSlot.database, filterSlot.table, {
        conds,
        where: built,
      });
    }
    onChangeWhere(built);
    onApplyWhere(built);
    return true;
  };

  /** 前に作った条件 (入力欄がそのときのままなら) */
  const savedConds = () =>
    filterSlot
      ? recallBuilt(filterSlot.session, filterSlot.database, filterSlot.table, where)
      : null;

  /** 絞り込みをやめて全件に戻す (入力欄を空にして取り直す) */
  const clearWhere = () => {
    if (editing) return;
    onChangeWhere("");
    onApplyWhere("");
    whereRef.current?.focus();
  };

  return (
    <div className="table-data" ref={rootRef}>
      {/*
        結果バー (SQL結果と共通の並び)。
        左に絞り込み、右に行の追加か「閲覧のみ」、件数とページ送り
      */}
      <ResultBar
        className="query-actions table-data-actions"
        lead={
          <>
            <span className="table-where-wrap">
              <input
                ref={whereRef}
                className={
                  "filter-input mono table-where has-tooltip tooltip-left tooltip-wide" +
                  (whereDirty ? " dirty" : "")
                }
                placeholder="絞り込み条件 (WHERE句。例: status = 1 AND name LIKE '%山%')"
                value={where}
                data-tooltip={
                  whereDirty
                    ? `まだ適用していません。表示中のデータの条件: ${
                        appliedWhere?.trim() ? appliedWhere : "(なし・全件)"
                      }`
                    : undefined
                }
                onChange={(e) => onChangeWhere(e.target.value)}
                onKeyDown={(e) => {
                  // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
                  if (imeBusy(e)) return;
                  // 取得中・行の編集中は受け付けない
                  // (連打すると古い結果が後から表示されうる。編集中は入力が消える)
                  if (e.key === "Enter" && !loading && !editing) onApplyWhere();
                  // Esc で条件を消して全件に戻す (書いてあるときだけ)
                  if (e.key === "Escape" && where !== "" && !loading && !editing) {
                    e.stopPropagation();
                    clearWhere();
                  }
                }}
              />
              <span className="table-where-tail">
                {/* 入力中の条件が、表示中のデータの条件と違うときの印 */}
                {whereDirty && (
                  <span
                    className="table-where-dirty has-tooltip"
                    data-tooltip="この条件はまだ適用していません (Enter か「絞り込む」で適用)"
                  >
                    未適用
                  </span>
                )}
                {where !== "" && (
                  <IconButton
                    className="table-where-clear"
                    label={lockReason ?? "条件を消して全件に戻す (Esc)"}
                    disabled={loading || !!editing}
                    onClick={clearWhere}
                  >
                    ×
                  </IconButton>
                )}
              </span>
            </span>
            <button
              className="btn-primary has-tooltip"
              onClick={() => onApplyWhere()}
              disabled={loading || !!editing}
              data-tooltip={
                lockReason ??
                "条件で絞り込み、先頭ページから取得し直します (Enter)\n" +
                  "条件を変えていなければ、そのまま再読み込みになります"
              }
            >
              {loading ? (
                <>
                  <span className="spinner light" /> 読み込み中…
                </>
              ) : (
                "絞り込む"
              )}
            </button>
            <button
              className="btn-secondary explain-btn has-tooltip"
              onClick={() => setBuilding({})}
              disabled={loading || dataColumns.length === 0 || !!editing}
              data-tooltip={
                lockReason ??
                "列と演算子を選んで WHERE句を組み立てます (列見出しの ▾ からも開けます)"
              }
            >
              条件を作る
            </button>
          </>
        }
        header={{ mode: headerMode, onChange: onChangeHeaderMode }}
        edit={
          editable && (
            <>
              {/* 行の追加は絞り込みとは別の操作なので、右側へ置く */}
              <button
                className="btn-secondary ddl-add-btn has-tooltip"
                onClick={startInsert}
                disabled={loading || !!editing}
                data-tooltip={lockReason ?? undefined}
              >
                <PlusIcon />
                行を追加
              </button>
              {/* 右クリックの操作に気づけるよう、構造タブと同じようにヒントを出す */}
              {!editing && (
                <span className="ddl-hint table-data-hint">
                  ダブルクリックで編集 / 右クリックで行の削除 / 見出しの ▾ で並べ替え・絞り込み
                </span>
              )}
            </>
          )
        }
        /* 編集できないときは、SQL結果と同じ位置に「閲覧のみ」と理由を出す */
        readOnly={editHint}
        meta={
          !loading && data
            ? {
                range: { kind: "page", offset, rows: data.rows.length },
                elapsedMs: data.elapsedMs,
                // 取り直さずに出していることがあるので、いつの内容かを添える
                fetchedAt,
              }
            : null
        }
        page={
          data
            ? {
                offset,
                hasMore: data.hasMore,
                // 編集中は押すと入力が消えるので押せなくし、理由を出す
                disabled: loading || !!editing,
                lockReason,
                onPage,
              }
            : null
        }
      />

      {error && (
        <div className="result-banner ng query-error">
          <span className="dot" aria-hidden />
          <strong>エラー</strong>
          <span className="result-detail">{error}</span>
        </div>
      )}

      {/* 編集の案内と、実行中・エラーの表示 */}
      <EditBar
        busy={busy}
        error={editError}
        onDismissError={() => setEditError(null)}
        editing={!!editing}
        changed={changed}
        hint={
          <>
            <EditKeysHint />
            {!changed && "（変更はまだありません）"}
          </>
        }
        tools={
          <button
            className="ddl-bar-btn has-tooltip"
            disabled={busy}
            data-tooltip="最後に選んでいた入力欄を NULL にします (文字の NULL ではなく、値が無いことを表す NULL)"
            // 押しても入力欄のフォーカスを外さない
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => patch(focusCol.current, null)}
          >
            NULL にする
          </button>
        }
        onCancel={cancel}
        onSave={commit}
      />

      <div className="table-data-grid">
        {loading && !data ? (
          <div className="content-placeholder dim-center">
            <span className="spinner accent" /> データを読み込み中…
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
            headerMenuItems={(id) =>
              id.startsWith("c")
                ? [
                    {
                      label: "この列で絞り込む…",
                      // 編集中に取り直すと入力が消えるので押せなくする
                      disabled: !!editing,
                      title: lockReason ?? undefined,
                      onSelect: () =>
                        setBuilding({ column: dataColumns[Number(id.slice(1))] }),
                    },
                  ]
                : []
            }
            rows={rows}
            rowValues={editing ? undefined : rowValueOf}
            clippedRowKeys={clippedRows}
            // まず200行だけ描き、スクロールに合わせて継ぎ足す
            maxRenderRows={200}
            // 画面を切り替えて戻ったとき、同じデータならスクロール位置を戻す
            memoKey={data}
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

      {building && (
        <WhereBuilder
          columns={dataColumns}
          columnTypes={columnTypes}
          columnLabels={columnLabels}
          initialColumn={building.column}
          initialConds={initialConds(
            savedConds(),
            dataColumns,
            building.column
          )}
          dbType={dbType}
          onApply={applyBuilt}
          onClose={() => setBuilding(null)}
        />
      )}

      {cellView && (
        <CellDetail
          key={`${cellView.row}:${cellView.column}`}
          column={dataColumns[cellView.column] ?? ""}
          value={cellView.value}
          clip={clipAt(cellView.row, cellView.column)}
          // 主キーの値がすべて揃っているときだけ、全文を読み直せる
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

      {askDialog}

      {deleting !== null && (
        <ConfirmDialog
          title="1行を削除します"
          confirmLabel="削除する"
          target={deleteLabel}
          prodNote={prod ? rowChangeText("delete", tableLabel) : undefined}
          onCancel={() => setDeleting(null)}
          onConfirm={() => deleteRow(deleting)}
        >
          この行のデータは失われ、元に戻せません。
        </ConfirmDialog>
      )}

      {/* 本番での確定 (追加・書き換え) の確認 */}
      {confirmRow && (
        <ConfirmDialog
          title="本番環境のデータを変更します"
          target={tableLabel}
          confirmLabel={confirmRow === "insert" ? "追加する" : "保存する"}
          tone="primary"
          prodNote={rowChangeText(confirmRow, tableLabel)}
          onCancel={() => setConfirmRow(null)}
          onConfirm={async () => {
            setConfirmRow(null);
            await applyEdit(true);
          }}
        >
          このテーブルへすぐに書き込まれ、元に戻せません。
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
