import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { kvApply } from "../api";
import { tryFormatValue } from "../kvFormat";
import type { KvChange, KvKeyDetail, KvRow } from "../types";

interface Props {
  sessionId: string;
  database: string;
  detail: KvKeyDetail;
  /** JSONなどを整形して表示するか */
  pretty: boolean;
  /** 変更後に詳細を取り直す */
  onReload: () => void;
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
}: Props) {
  /** 編集中の行 (indexは表示中の行番号) */
  const [edit, setEdit] = useState<{
    index: number;
    field: string;
    value: string;
  } | null>(null);
  /** 追加中の入力 (nullなら追加していない) */
  const [adding, setAdding] = useState<KvRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 行の右クリックメニュー */
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(
    null
  );

  const type = detail.type;
  // stringは値ひとつなので、1列目 (項目) は出さない
  const showField = type !== "string";
  const canAdd = ELEMENT_TYPES.includes(type);
  const canRemove = ELEMENT_TYPES.includes(type);
  const needField = type === "hash" || type === "zset" || type === "stream";

  // キーが変わったら編集状態を捨てる
  useEffect(() => {
    setEdit(null);
    setAdding(null);
    setError(null);
  }, [detail.key, detail.type]);

  // 入力欄からフォーカスが外れていてもEscで取り消せるようにする
  useEffect(() => {
    if (!edit && !adding) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setEdit(null);
      setAdding(null);
      setError(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [edit, adding]);

  // メニューは外側クリック・スクロールで閉じる
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  /** 変更を実行する。成功したら詳細を取り直す */
  const apply = async (change: KvChange) => {
    setBusy(true);
    setError(null);
    try {
      await kvApply(sessionId, database, change);
      setEdit(null);
      setAdding(null);
      onReload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
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
    const reason = editableReason(type, row, detail.truncated);
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

  /** 値の入力欄の行数 (改行を含む値は広げる) */
  const valueRows = (text: string) =>
    Math.min(Math.max(text.split("\n").length, type === "string" ? 6 : 2), 16);

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

      <div className="grid-wrap kv-value-wrap">
        <table className="grid mono kv-value-grid">
          <thead>
            <tr>
              {showField && <th>{detail.cols[0]}</th>}
              <th>{detail.cols[1]}</th>
            </tr>
          </thead>
          <tbody>
            {detail.rows.map(([a, b], i) =>
              edit?.index === i ? (
                <tr key={i} className="row-editing">
                  {showField && (
                    <td className="kv-cell-a">
                      {FIELD_EDITABLE.includes(type) ? (
                        <input
                          className="cell-input mono"
                          autoFocus
                          value={edit.field}
                          onChange={(e) =>
                            setEdit({ ...edit, field: e.target.value })
                          }
                          {...editKeys(commitEdit, () => setEdit(null))}
                        />
                      ) : (
                        a
                      )}
                    </td>
                  )}
                  <td className="kv-cell-b">
                    <textarea
                      className="cell-input cell-textarea mono"
                      autoFocus={!FIELD_EDITABLE.includes(type)}
                      rows={valueRows(edit.value)}
                      value={edit.value}
                      onChange={(e) =>
                        setEdit({ ...edit, value: e.target.value })
                      }
                      {...editKeys(commitEdit, () => setEdit(null))}
                    />
                  </td>
                </tr>
              ) : (
                <tr
                  key={i}
                  onDoubleClick={() => startEdit(i)}
                  onContextMenu={(e) => {
                    if (!canRemove) return;
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, index: i });
                  }}
                >
                  {showField && <td className="kv-cell-a">{a}</td>}
                  <td className="kv-cell-b">
                    {pretty ? (tryFormatValue(b) ?? b) : b}
                  </td>
                </tr>
              )
            )}
            {adding && (
              <tr className="row-new">
                {showField && (
                <td className="kv-cell-a">
                  {needField ? (
                    <input
                      className="cell-input mono"
                      autoFocus
                      placeholder={addFieldLabel(type)}
                      value={adding.field}
                      onChange={(e) =>
                        setAdding({ ...adding, field: e.target.value })
                      }
                      {...editKeys(commitAdd, () => setAdding(null))}
                    />
                  ) : (
                    <span className="kv-cell-dim">自動</span>
                  )}
                </td>
                )}
                <td className="kv-cell-b">
                  <textarea
                    className="cell-input cell-textarea mono"
                    autoFocus={!needField}
                    rows={valueRows(adding.value)}
                    placeholder="値"
                    value={adding.value}
                    onChange={(e) =>
                      setAdding({ ...adding, value: e.target.value })
                    }
                    {...editKeys(commitAdd, () => setAdding(null))}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {menu &&
        createPortal(
          <div
            className="context-menu"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="context-item danger"
              onClick={() => {
                const i = menu.index;
                setMenu(null);
                removeRow(i);
              }}
            >
              この要素を削除
            </button>
          </div>,
          document.body
        )}
    </>
  );
}
