/**
 * 左ペインのテーブル一覧 (行の描画だけを受け持つ)。
 *
 * SQLエディタに1文字打つたびに SessionView は描き直されるが、
 * テーブル一覧はそのとき何も変わらない。
 * ここを memo で切り離しておくと、
 * 数百件のテーブルを毎キーストローク作り直さずに済む
 * (そのため、渡す関数は呼び出し側で useCallback に包んでおくこと)
 */
import { memo } from "react";
import { tableKey } from "../tableSql";
import type { TableInfo } from "../types";

/** テーブル種別の短い印 (T / V / MV / F) */
export function typeLabel(t: string): { label: string; cls: string } {
  if (t === "VIEW") return { label: "V", cls: "view" };
  if (t === "MATERIALIZED VIEW") return { label: "MV", cls: "view" };
  if (t === "FOREIGN TABLE") return { label: "F", cls: "view" };
  return { label: "T", cls: "table" };
}

export interface TableListProps {
  /** 絞り込み後の一覧 (この並びが Shift 範囲選択の基準になる) */
  tables: TableInfo[];
  /** 一覧が空のときの文言 (テーブルが無いのか、絞り込みの結果か) */
  emptyLabel: string;
  /** 選択中のテーブルキー */
  selectedKey: string | null;
  /** 複数選択中のテーブルキー */
  multiSel: Set<string>;
  /** 右クリックから数えた件数 (キーごとの表示用文字列) */
  counts: Record<string, string>;
  /** スキーマ名も並べて出すか (複数スキーマがあるときだけ) */
  showSchema: boolean;
  /** テーブルの日本語名 (無ければ空文字) */
  logicalOf: (t: TableInfo) => string;
  /** 名前を変更中の行 (キーと入力中の値) */
  renaming: { key: string; value: string } | null;
  /** 名前の変更に失敗したときの文言 */
  renameError: string | null;
  onRenameInput: (value: string) => void;
  onRenameCommit: (t: TableInfo) => void;
  onRenameCancel: () => void;
  onItemClick: (e: React.MouseEvent, t: TableInfo) => void;
  onItemContextMenu: (e: React.MouseEvent, t: TableInfo) => void;
}

/** 名前を変更中の行 (その場で入力欄に差し替える) */
function RenameRow({
  table,
  value,
  error,
  onInput,
  onCommit,
  onCancel,
}: {
  table: TableInfo;
  value: string;
  error: string | null;
  onInput: (value: string) => void;
  onCommit: (t: TableInfo) => void;
  onCancel: () => void;
}) {
  const badge = typeLabel(table.tableType);
  return (
    <>
      <div className="rename-table-row">
        <span className={`type-chip mini ${badge.cls}`}>{badge.label}</span>
        <input
          className="mono"
          autoFocus
          value={value}
          onChange={(e) => onInput(e.target.value)}
          title="Enterで確定 / Escで取消"
          onKeyDown={(e) => {
            // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit(table);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          /*
           * 別の場所をクリックしても確定も破棄もしない。
           * 以前はここで RENAME TABLE を実行していたため、
           * 入力途中のクリックでテーブル名が変わってしまった
           */
        />
        {/* 確定と取消 (押しても入力欄からフォーカスを外さない) */}
        <button
          className="inline-apply-btn"
          title="この名前に変更する (Enter)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onCommit(table)}
        >
          ✓
        </button>
        <button
          className="inline-apply-btn"
          title="やめる (Esc)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCancel}
        >
          ✕
        </button>
      </div>
      {error && <p className="new-table-error">{error}</p>}
    </>
  );
}

/** 通常の行 */
function TableRow({
  table,
  selected,
  multi,
  count,
  showSchema,
  logical,
  onClick,
  onContextMenu,
}: {
  table: TableInfo;
  selected: boolean;
  multi: boolean;
  count: string | undefined;
  showSchema: boolean;
  logical: string;
  onClick: (e: React.MouseEvent, t: TableInfo) => void;
  onContextMenu: (e: React.MouseEvent, t: TableInfo) => void;
}) {
  const badge = typeLabel(table.tableType);
  return (
    <button
      className={
        "side-table-item" + (selected ? " selected" : "") + (multi ? " multi" : "")
      }
      onClick={(e) => onClick(e, table)}
      onContextMenu={(e) => onContextMenu(e, table)}
      // MySQLはschemaが無いため、keyそのまま (".table名") ではなく表示用の名前を出す
      title={table.schema ? `${table.schema}.${table.name}` : table.name}
    >
      <span className={`type-chip mini ${badge.cls}`}>{badge.label}</span>
      <span className="side-table-name mono">
        {showSchema && table.schema && (
          <span className="table-schema">{table.schema}.</span>
        )}
        {table.name}
      </span>
      {logical && (
        <span className="side-table-logical" title={logical}>
          {logical}
        </span>
      )}
      {count && (
        <span
          className="side-table-count mono"
          title="右クリックから数えた正確な件数"
        >
          {count}
        </span>
      )}
    </button>
  );
}

function TableListInner({
  tables,
  emptyLabel,
  selectedKey,
  multiSel,
  counts,
  showSchema,
  logicalOf,
  renaming,
  renameError,
  onRenameInput,
  onRenameCommit,
  onRenameCancel,
  onItemClick,
  onItemContextMenu,
}: TableListProps) {
  return (
    <ul className="side-table-list">
      {tables.map((t) => {
        const key = tableKey(t);
        return (
          <li key={key}>
            {renaming?.key === key ? (
              <RenameRow
                table={t}
                value={renaming.value}
                error={renameError}
                onInput={onRenameInput}
                onCommit={onRenameCommit}
                onCancel={onRenameCancel}
              />
            ) : (
              <TableRow
                table={t}
                selected={selectedKey === key}
                multi={multiSel.has(key)}
                count={counts[key]}
                showSchema={showSchema}
                logical={logicalOf(t)}
                onClick={onItemClick}
                onContextMenu={onItemContextMenu}
              />
            )}
          </li>
        );
      })}
      {tables.length === 0 && <li className="table-pane-empty">{emptyLabel}</li>}
    </ul>
  );
}

export const TableList = memo(TableListInner);
