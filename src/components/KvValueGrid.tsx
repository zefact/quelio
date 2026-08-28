import { ReactNode, useEffect, useMemo, useState } from "react";
import { kvApply } from "../api";
import { tryFormatValue } from "../kvFormat";
import type { KvChange, KvKeyDetail, KvRow } from "../types";
import { GridColumn, GridRow, ResizableGrid } from "./ResizableGrid";
import {
  useAsyncApply,
  useEscapeCancel,
} from "../hooks/useEditableGrid";

interface Props {
  sessionId: string;
  database: string;
  detail: KvKeyDetail;
  /** JSONなどを整形して表示するか */
  pretty: boolean;
  /** 変更後に詳細を取り直す */
  onReload: () => void;
  /** 読み取り専用の接続か (値の追加・変更・削除を出さない) */
  readOnly?: boolean;
}

/** 1列目 (フィールド名・スコア) を書き換えられる型 */
const FIELD_EDITABLE = ["hash", "zset"];
/** 値を書き換えられる型 */
const VALUE_EDITABLE = ["string", "hash", "list", "set", "zset"];
/** 要素を足したり消したりできる型 */
const ELEMENT_TYPES = ["hash", "list", "set", "zset", "stream"];

/** 表示用に変換された値 (バイナリ) は編集させない */
function isBinary(text: string): boolean {
  return text.startsWith("(バイナリ ");
}

/** 長すぎて途中までしか取れていない値も編集させない */
function isClipped(text: string): boolean {
  return /…\s*\(\d+バイト\)$/.test(text);
}

/** その行を編集できるか (できないときは理由を返す) */
function editableReason(
  type: string,
  row: [string, string],
  truncated: boolean
): string | null {
  if (type === "string" && truncated) {
    return "値が長く先頭しか読めていないため編集できません (コンソールから操作してください)";
  }
  if (type === "stream") {
    return "streamの既存エントリは変更できません (追加と削除のみ)";
  }
  if (!VALUE_EDITABLE.includes(type)) {
    return `${type} 型の編集には対応していません`;
  }
  if (isBinary(row[1]) || isBinary(row[0])) {
    return "バイナリの値は壊れる恐れがあるため編集できません (コンソールから操作してください)";
  }
  if (isClipped(row[1])) {
    return "値が長く先頭しか読めていないため編集できません (コンソールから操作してください)";
  }
  return null;
}

/** 追加フォームの1列目のラベル */
function addFieldLabel(type: string): string {
  switch (type) {
    case "hash":
      return "フィールド";
    case "zset":
      return "スコア";
    case "stream":
      return "フィールド";
    default:
      return "";
  }
}

/** キーの値ビュー (ダブルクリックでその場編集・追加・削除) */
export function KvValueGrid({
  sessionId,
  database,
  detail,
  pretty,
  onReload,
  readOnly,
}: Props) {
  /** 編集中の行 (indexは表示中の行番号) */
  const [edit, setEdit] = useState<{
    index: number;
    field: string;
    value: string;
  } | null>(null);
  /** 追加中の入力 (nullなら追加していない) */
  const [adding, setAdding] = useState<KvRow | null>(null);
  const { busy, error, setError, run } = useAsyncApply<KvChange>((change) =>
    kvApply(sessionId, database, change)
  );

  const type = detail.type;
  // stringは値ひとつなので、1列目 (項目) は出さない
  const showField = type !== "string";
  const canAdd = !readOnly && ELEMENT_TYPES.includes(type);
  const canRemove = !readOnly && ELEMENT_TYPES.includes(type);
  const needField = type === "hash" || type === "zset" || type === "stream";

  // キーが変わったら編集状態を捨てる
  useEffect(() => {
    setEdit(null);
    setAdding(null);
    setError(null);
  }, [detail.key, detail.type, setError]);

  // 入力欄からフォーカスが外れていてもEscで取り消せるようにする
  useEscapeCancel(
    !!edit || !!adding,
    () => {
      setEdit(null);
      setAdding(null);
      setError(null);
    },
    // 同じEscでキー名の編集まで取り消さない
    { preventDefault: true }
  );

  /** 変更を実行する。成功したら詳細を取り直す */
  const apply = async (change: KvChange) => {
    // 失敗したら直せるよう、入力はそのまま残す
    if (!(await run(change))) return;
    setEdit(null);
    setAdding(null);
    onReload();
  };

  /** 編集中の行を確定する */
  const commitEdit = () => {
    if (!edit) return;
    const before = detail.rows[edit.index];
    if (!before) return;
    if (before[0] === edit.field && before[1] === edit.value) {
      setEdit(null);
      return;
    }
    void apply({
      kind: "update",
      key: detail.key,
      kvType: type,
      before: { field: before[0], value: before[1] },
      after: { field: edit.field, value: edit.value },
    });
  };

  /** 追加を確定する */
  const commitAdd = () => {
    if (!adding) return;
    void apply({
      kind: "insert",
      key: detail.key,
      kvType: type,
      row: adding,
    });
  };

  /** 1件削除する (取り消せないが、要素1件なので確認は挟まない) */
  const removeRow = (index: number) => {
    const row = detail.rows[index];
    if (!row) return;
    void apply({
      kind: "remove",
      key: detail.key,
      kvType: type,
      row: { field: row[0], value: row[1] },
    });
  };

  /** ダブルクリックで編集モードへ */
  const startEdit = (index: number) => {
    if (busy || edit) return;
    const row = detail.rows[index];
    if (!row) return;
    const reason = readOnly
      ? "読み取り専用の接続のため変更できません"
      : editableReason(type, row, detail.truncated);
    if (reason) {
      setError(reason);
      return;
    }
    setError(null);
    setEdit({ index, field: row[0], value: row[1] });
  };

  /** 編集入力の共通キー操作 (Enterで確定 / Escで取消) */
  const editKeys = (commit: () => void, cancel: () => void) => ({
    onKeyDown: (e: React.KeyboardEvent) => {
      // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter") {
        // 値の入力欄では Shift+Enter を改行に使うため、そのときは確定しない
        if (e.shiftKey) return;
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    },
  });

  /*
   * 整形した値。JSONの解析と整形は重いので、
   * 行と「整形して表示」の指定が変わったときだけ作り直す
   */
  const formatted = useMemo(
    () => (pretty ? detail.rows.map(([, b]) => tryFormatValue(b)) : []),
    [detail.rows, pretty]
  );

  /** 値の入力欄の行数 (改行を含む値は広げる) */
  const valueRows = (text: string) =>
    Math.min(Math.max(text.split("\n").length, type === "string" ? 6 : 2), 16);

  /** 追加中の行のキー (行番号と混ざらない文字にする) */
  const NEW_ROW = "new";

  /** 表示する列 (stringは値ひとつなので項目の列を出さない) */
  const columns: GridColumn[] = useMemo(() => {
    const value: GridColumn = {
      id: "value",
      label: detail.cols[1],
      width: 420,
      wrap: true,
      cellClass: "kv-cell-b",
    };
    return showField
      ? [
          {
            id: "field",
            label: detail.cols[0],
            width: 200,
            wrap: true,
            cellClass: "kv-cell-a",
          },
          value,
        ]
      : [value];
  }, [detail.cols, showField]);

  /** 編集中の行のセル (項目名を書き換えられる型だけ入力欄にする) */
  const editCells = (): ReactNode[] => {
    if (!edit) return [];
    const cells: ReactNode[] = [];
    if (showField) {
      cells.push(
        FIELD_EDITABLE.includes(type) ? (
          <input
            className="cell-input mono"
            autoFocus
            value={edit.field}
            onChange={(e) => setEdit({ ...edit, field: e.target.value })}
            {...editKeys(commitEdit, () => setEdit(null))}
          />
        ) : (
          edit.field
        )
      );
    }
    cells.push(
      <textarea
        className="cell-input cell-textarea mono"
        autoFocus={!FIELD_EDITABLE.includes(type)}
        rows={valueRows(edit.value)}
        value={edit.value}
        onChange={(e) => setEdit({ ...edit, value: e.target.value })}
        {...editKeys(commitEdit, () => setEdit(null))}
      />
    );
    return cells;
  };

  /** 追加中の行のセル */
  const addCells = (): ReactNode[] => {
    if (!adding) return [];
    const cells: ReactNode[] = [];
    if (showField) {
      cells.push(
        needField ? (
          <input
            className="cell-input mono"
            autoFocus
            placeholder={addFieldLabel(type)}
            value={adding.field}
            onChange={(e) => setAdding({ ...adding, field: e.target.value })}
            {...editKeys(commitAdd, () => setAdding(null))}
          />
        ) : (
          <span className="kv-cell-dim">自動</span>
        )
      );
    }
    cells.push(
      <textarea
        className="cell-input cell-textarea mono"
        autoFocus={!needField}
        rows={valueRows(adding.value)}
        placeholder="値"
        value={adding.value}
        onChange={(e) => setAdding({ ...adding, value: e.target.value })}
        {...editKeys(commitAdd, () => setAdding(null))}
      />
    );
    return cells;
  };

  /** グリッドに渡す行 (編集中の行は入力欄に差し替え、追加中の行は末尾に足す) */
  const rows: GridRow[] = detail.rows.map(([a, b], i) => {
    if (edit?.index === i) {
      return { key: String(i), className: "row-editing", cells: editCells() };
    }
    const cells: ReactNode[] = [];
    if (showField) cells.push(a);
    cells.push(pretty ? (formatted[i] ?? b) : b);
    return { key: String(i), cells };
  });
  if (adding) {
    rows.push({ key: NEW_ROW, className: "row-new", cells: addCells() });
  }

  /** コピー用の元の値 (整形前の、サーバーから来たそのままの値) */
  const rowValueOf = (key: string) => {
    const row = detail.rows[Number(key)];
    if (!row) return undefined;
    return showField ? [row[0], row[1]] : [row[1]];
  };

  return (
    <>
      <div className="kv-value-bar">
        {canAdd && (
          <button
            className="sql-btn"
            disabled={busy || !!edit || !!adding}
            onClick={() => setAdding({ field: "", value: "" })}
          >
            + 要素を追加
          </button>
        )}
        {(edit || adding) && (
          <span className="ddl-bar-text">
            <kbd>Enter</kbd> で反映 / <kbd>Shift</kbd>+<kbd>Enter</kbd> で改行 /{" "}
            <kbd>Esc</kbd> で取り消し
          </span>
        )}
        <span className="toolbar-spacer" />
        {busy && <span className="spinner" />}
      </div>

      {error && (
        <div className="result-banner ng kv-edit-error">
          <span className="dot" aria-hidden />
          <span className="result-detail">{error}</span>
        </div>
      )}

      <ResizableGrid
        columns={columns}
        rows={rows}
        wrapClass="kv-value-wrap"
        emptyText="値がありません"
        // 編集中は行選択のショートカット (⌘A/⌘C) が入力の邪魔になるので切る
        selectable={!edit && !adding}
        rowValues={rowValueOf}
        // 追加中の行は末尾にあるので、切り詰めても必ず描く
        pinLastRow={!!adding}
        onCellDoubleClick={(key) => {
          if (key !== NEW_ROW) startEdit(Number(key));
        }}
        rowMenuItems={(key) =>
          canRemove && key !== NEW_ROW
            ? [
                {
                  label: "この要素を削除",
                  danger: true,
                  onSelect: () => removeRow(Number(key)),
                },
              ]
            : []
        }
      />
    </>
  );
}
