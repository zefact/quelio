import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  APP_SETTINGS_EVENT,
  applyColumnDdl,
  applyForeignKeyDdl,
  applyIndexDdl,
  applyRowChange,
  fetchCell,
  tableDdl,
  getAppSettings,
  listCollations,
  listColumnTypes,
  previewColumnDdl,
  setTableComment,
} from "../api";
import { buildColumnTips } from "../columnTips";
import { quoteIdent, quoteTable } from "../tableSql";
import { parseComment } from "../comment";
import type {
  AppSettings,
  ColumnChange,
  ColumnInfo,
  ForeignKeyChange,
  DbType,
  IndexChange,
  CellValue,
  RowCell,
  RowChange,
  TableDetail,
  TableInfo,
  TableTab,
} from "../types";
import { joinComment } from "./columnDraft";
import { DdlDialog } from "./DdlDialog";
import { DropColumnConfirm } from "./DropColumnConfirm";
import { StructureView } from "./StructureView";
import { TableDataView } from "./TableDataView";

import type { TableDataPane } from "./panes";

interface Props {
  table: TableInfo;
  /** DDL (カラム変更) 用の接続情報 */
  sessionId: string;
  database?: string;
  dbType: DbType;
  /** 読み取り専用の接続か (変更操作をすべて出さない) */
  readOnly?: boolean;
  /** 定義を取得し直す (DDL実行後) */
  onReloadDetail: () => void;
  /** 生成したSQLをSQLエディタへ送る */
  onSendToEditor: (sql: string) => void;
  /** 表示中のタブ (定義 / データ) */
  view: TableTab;
  onChangeView: (view: TableTab) => void;
  // ---- 定義タブ ----
  detail: TableDetail | null;
  loadingDetail: boolean;
  /** データタブの状態と操作 (ここでは中身を見ず、そのまま渡す) */
  dataPane: TableDataPane;
}

function typeChip(t: string): string {
  if (t.includes("VIEW")) return "view";
  return "table";
}

/** 定義タブのアイコン (行が並んだ一覧) */
function DefIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 6h16M4 12h16M4 18h10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** データタブのアイコン (表) */
function DataIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M3 9h18M9 9v11" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

const TABS: [TableTab, string, () => ReactNode][] = [
  ["definition", "定義", DefIcon],
  ["data", "データ", DataIcon],
];

/** 選択テーブルの表示。ヘッダ + 「定義 / データ」タブの切り替えを担う */
export function TableView({
  table,
  sessionId,
  database,
  dbType,
  readOnly,
  onReloadDetail,
  onSendToEditor,
  view,
  onChangeView,
  detail,
  loadingDetail,
  dataPane,
}: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  /** 削除の確認中カラム (削除は取り返しがつかないので確認を出す) */
  const [dropping, setDropping] = useState<ColumnInfo | null>(null);
  /** 型・照合順序の選択肢 (接続とDBが変わったら取り直す) */
  const [types, setTypes] = useState<string[]>([]);
  const [collations, setCollations] = useState<string[]>([]);
  /** テーブルの日本語名 (コメント) を編集中の値。nullなら表示のみ */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  /** Enterとフォーカスアウトで二重に実行しないためのガード */
  const nameBusy = useRef(false);

  /** カラムの変更をそのまま実行する (失敗は呼び出し元へ投げ返す) */
  const applyDdl = async (change: ColumnChange) => {
    await applyColumnDdl(sessionId, database, table.schema, table.name, change);
    onReloadDetail();
  };

  /** 実行せずに、生成されるSQLだけを取得する (並べ替えの確認用) */
  const previewDdl = (change: ColumnChange) =>
    previewColumnDdl(sessionId, table.schema, table.name, change);

  /** インデックスの変更をそのまま実行する */
  const applyIndex = async (change: IndexChange) => {
    await applyIndexDdl(sessionId, database, table.schema, table.name, change);
    onReloadDetail();
  };

  /** 外部キーの追加・削除を実行し、定義を取得し直す */
  const applyForeignKey = async (change: ForeignKeyChange) => {
    await applyForeignKeyDdl(
      sessionId,
      database,
      table.schema,
      table.name,
      change
    );
    onReloadDetail();
  };

  /** CREATE文の表示中か */
  const [showDdl, setShowDdl] = useState(false);

  /*
   * データタブ (TableDataView) は React.memo で包んであるので、
   * 渡す関数・配列は毎回作り直さない。
   * そうしないと、定義タブ側の状態が変わるたびに表全体が描き直される
   */
  const target = useRef({ sessionId, database, table, dbType, dataPane });
  target.current = { sessionId, database, table, dbType, dataPane };

  /** 切り詰められたセルの全文を読み直す */
  const fetchFullCell = useCallback(
    (column: string, key: RowCell[]): Promise<CellValue> => {
      const t = target.current;
      return fetchCell(
        t.sessionId,
        t.database,
        t.table.schema,
        t.table.name,
        column,
        key
      );
    },
    []
  );

  /** データ1行の追加・更新・削除を実行し、一覧を取得し直す */
  const applyRow = useCallback(async (change: RowChange) => {
    const t = target.current;
    await applyRowChange(
      t.sessionId,
      t.database,
      t.table.schema,
      t.table.name,
      change
    );
    t.dataPane.onReload();
  }, []);

  /** カラム名をDBの書き方でクォートする (INSERT文のコピー用) */
  const quoteName = useCallback(
    (name: string) => quoteIdent(target.current.dbType, name),
    []
  );

  /** 主キーの判定に使うカラム定義 (未取得なら空のまま作り直さない) */
  const dataColumns = useMemo(() => detail?.columns ?? [], [detail]);

  /** ビューとValkeyは定義を変更できない。読み取り専用の接続も同じ扱い */
  const canEdit =
    !readOnly &&
    dbType !== "valkey" &&
    !table.tableType.toUpperCase().includes("VIEW");
  /** 編集できないときの理由 (画面に出す) */
  const editDisabledReason = readOnly
    ? "この接続は読み取り専用です (接続設定で変更できます)"
    : table.tableType.toUpperCase().includes("VIEW")
      ? "ビューは直接編集できません (元のテーブルを編集してください)"
      : undefined;
  /** SQLiteにはテーブルコメントの仕組みが無い */
  const canName = canEdit && dbType !== "sqlite";

  // 設定 (表示モード・区切り文字・行番号) はテーブル切替と、
  // 設定モーダルでの変更のたびに読み直す
  useEffect(() => {
    const load = () => {
      getAppSettings().then(setSettings).catch(() => {});
    };
    load();
    window.addEventListener(APP_SETTINGS_EVENT, load);
    return () => window.removeEventListener(APP_SETTINGS_EVENT, load);
  }, [table]);

  // 型・照合順序の選択肢はDB単位で決まるので、接続とDBが変わったときだけ取り直す
  useEffect(() => {
    if (dbType === "valkey") {
      setTypes([]);
      setCollations([]);
      return;
    }
    let alive = true;
    // SQLiteはDB名を持たないので空文字で呼ぶ (バックエンド側で無視する)
    const db = database ?? "";
    listColumnTypes(sessionId, db)
      .then((v) => alive && setTypes(v))
      .catch(() => alive && setTypes([]));
    if (dbType === "sqlite") {
      setCollations([]);
    } else {
      listCollations(sessionId, db)
        .then((v) => alive && setCollations(v))
        .catch(() => alive && setCollations([]));
    }
    return () => {
      alive = false;
    };
  }, [sessionId, database, dbType]);

  const split = settings?.structureCommentMode === "split";
  const delim = settings?.commentDelimiter ?? "（";

  /** データタブのヘッダに出すカラム説明 (論理名・補足・型) */
  const columnTips = useMemo(
    () => buildColumnTips(detail?.columns ?? [], delim),
    [detail, delim]
  );

  /** テーブルコメントの論理名 (split時に英字テーブル名の横へ出す) */
  const tableComment =
    detail?.info.find(([label]) => label === "コメント")?.[1] ?? "";
  const [tableLogical, tableNote] = parseComment(tableComment, delim);
  /** 見出しに出す日本語名 (分割表示なら論理名だけ、それ以外はコメント全体) */
  const displayName = split ? tableLogical : tableComment;

  /** 日本語名の編集を始める */
  const startEditName = () => {
    if (!canName) return;
    setNameError(null);
    setNameDraft(displayName);
  };

  /** 入力された日本語名をテーブルコメントとして保存する (確認は挟まない) */
  const saveName = async () => {
    if (nameBusy.current || nameDraft === null) return;
    const next = nameDraft.trim();
    if (next === displayName.trim()) {
      setNameDraft(null);
      setNameError(null);
      return;
    }
    // 分割表示のときは補足を残したままにする
    const comment = split ? joinComment(next, tableNote, delim) : next;
    nameBusy.current = true;
    setNameError(null);
    try {
      await setTableComment(
        sessionId,
        database,
        table.schema,
        table.name,
        comment
      );
      setNameDraft(null);
      onReloadDetail();
    } catch (e) {
      setNameError(String(e));
    } finally {
      nameBusy.current = false;
    }
  };

  // テーブルを切り替えたら編集状態を解除する
  useEffect(() => {
    setNameDraft(null);
    setNameError(null);
  }, [table]);

  return (
    <div className="table-view">
      <div className="content-table-head">
        <span className={`type-chip ${typeChip(table.tableType)}`}>
          {table.tableType}
        </span>
        <h2 className="mono">
          {table.schema ? `${table.schema}.` : ""}
          {table.name}
        </h2>
        {nameDraft !== null ? (
          <input
            className="table-logical-input"
            autoFocus
            value={nameDraft}
            placeholder="日本語名 (テーブルコメント)"
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                saveName();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setNameDraft(null);
                setNameError(null);
              }
            }}
            title="Enterで確定 / Escで取消"
            /*
             * 別の場所をクリックしても確定も破棄もしない。
             * 以前はここで ALTER TABLE … COMMENT を実行していたため、
             * 入力途中のクリックで定義が変わってしまった
             */
          />
        ) : null}
        {nameDraft !== null ? (
          <button
            className="inline-apply-btn"
            title="この日本語名にする (Enter)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={saveName}
          >
            ✓
          </button>
        ) : null}
        {nameDraft !== null ? (
          <button
            className="inline-apply-btn"
            title="やめる (Esc)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setNameDraft(null);
              setNameError(null);
            }}
          >
            ✕
          </button>
        ) : displayName ? (
          <span
            className={"table-logical" + (canName ? " editable" : "")}
            title={
              canName ? `${tableComment}\n(ダブルクリックで変更)` : tableComment
            }
            onDoubleClick={startEditName}
          >
            {displayName}
          </span>
        ) : (
          canName && (
            <button className="table-logical-add" onClick={startEditName}>
              ＋ 日本語名
            </button>
          )
        )}
        {nameError && <span className="table-logical-error">{nameError}</span>}
        <span className="toolbar-spacer" />
        {/* 定義を人に渡すとき用。表示するだけで実行はしない */}
        <button
          className="btn-ghost table-ddl-btn"
          onClick={() => setShowDdl(true)}
          title="CREATE 文を表示してコピーする"
        >
          CREATE 文
        </button>
      </div>

      <div className="table-tabs" role="tablist">
        {TABS.map(([v, label, Icon]) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            className={"table-tab" + (view === v ? " active" : "")}
            onClick={() => onChangeView(v)}
          >
            <Icon />
            {label}
          </button>
        ))}
      </div>

      <div className={"table-view-body" + (view === "data" ? " fill" : "")}>
        {view === "definition" ? (
          <StructureView
            detail={detail}
            loading={loadingDetail}
            split={split}
            delim={delim}
            canEdit={canEdit}
            dbType={dbType}
            resetKey={`${table.schema ?? ""}.${table.name}`}
            onApplyDdl={applyDdl}
            onPreviewDdl={previewDdl}
            onRequestDrop={setDropping}
            onApplyIndexDdl={applyIndex}
            onApplyForeignKeyDdl={applyForeignKey}
            types={types}
            collations={collations}
          />
        ) : (
          <TableDataView
            pane={dataPane}
            showRowNumbers={settings?.showRowNumbers ?? true}
            columnTips={columnTips}
            tableColumns={dataColumns}
            canEdit={canEdit}
            editDisabledReason={editDisabledReason}
            insertTable={quoteTable(dbType, table)}
            quoteName={quoteName}
            dbType={dbType}
            onApplyRow={applyRow}
            onFetchCell={fetchFullCell}
          />
        )}
      </div>

      {showDdl && (
        <DdlDialog
          // テーブルが変わったら作り直す
          key={`${table.schema ?? ""}.${table.name}`}
          table={table.schema ? `${table.schema}.${table.name}` : table.name}
          onLoad={() =>
            tableDdl(sessionId, database, table.schema, table.name)
          }
          onClose={() => setShowDdl(false)}
        />
      )}

      {dropping && (
        <DropColumnConfirm
          sessionId={sessionId}
          database={database}
          schema={table.schema}
          table={table.name}
          column={dropping}
          onClose={() => setDropping(null)}
          onApplied={onReloadDetail}
          onSendToEditor={onSendToEditor}
        />
      )}
    </div>
  );
}
