import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  APP_SETTINGS_EVENT,
  createTable,
  getAppSettings,
  openEr,
  openSchema,
  renameTable,
  schemaColumns,
} from "../api";
import { badgeStyle, dbBadgeLabel } from "../colors";
import { parseComment } from "../comment";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { tableKey } from "../tableSql";
import type { AppSettings, TableInfo, TableTab, WorkTab } from "../types";
import type { SchemaMap } from "./sqlCompletion";
import { DropTableConfirm } from "./DropTableConfirm";
import { QueryPanel } from "./QueryPanel";
import { SelectMenu } from "./SelectMenu";
import { TableView } from "./TableView";
import { ExportDialog, ImportDialog } from "./TransferDialog";

interface Props {
  tab: WorkTab;
  onSelectDb: (db: string) => void;
  /** テーブル一覧の再読み込み (選択中のテーブルは維持する) */
  onReloadTables: () => Promise<void> | void;
  /** 選択中テーブルの定義を取得し直す (DDL実行後) */
  onReloadDetail: () => void;
  /** 生成したSQLをSQLエディタへ送る */
  onSendToEditor: (sql: string) => void;
  onSelectTable: (table: TableInfo) => void;
  onToggleQuery: () => void;
  onChangeSql: (sql: string) => void;
  onRunQuery: (
    offset: number,
    sqlOverride?: string,
    transaction?: boolean,
    explain?: "explain" | "analyze"
  ) => void;
  /** 実行中SQLのキャンセル */
  onCancelQuery: () => void;
  /** 結果タブ単位のページ送り */
  onPageQuery: (index: number, offset: number) => void;
  /** サーバーサイドソートの変更 */
  onSortQuery: (
    index: number,
    orderBy: string | null,
    orderDir: "asc" | "desc"
  ) => void;
  /** 定義 / データ タブの切替 */
  onChangeTableTab: (view: TableTab) => void;
  /** データタブの絞り込み条件の変更 */
  onChangeWhere: (where: string) => void;
  /** 絞り込みを適用して先頭ページから取得し直す */
  onApplyWhere: () => void;
  /** 表示中のページを取得し直す */
  onReloadData: () => void;
  /** データタブのページ送り */
  onPageData: (offset: number) => void;
  /** データタブのソート変更 */
  onSortData: (orderBy: string | null, orderDir: "asc" | "desc") => void;
}

function typeLabel(t: string): { label: string; cls: string } {
  if (t === "VIEW") return { label: "V", cls: "view" };
  if (t === "MATERIALIZED VIEW") return { label: "MV", cls: "view" };
  if (t === "FOREIGN TABLE") return { label: "F", cls: "view" };
  return { label: "T", cls: "table" };
}

/** 接続済みタブの中身: 上部DBセレクタ + 左テーブル一覧 + コンテンツ領域 */
export function SessionView({
  tab,
  onSelectDb,
  onReloadTables,
  onReloadDetail,
  onSendToEditor,
  onSelectTable,
  onToggleQuery,
  onChangeSql,
  onRunQuery,
  onCancelQuery,
  onPageQuery,
  onSortQuery,
  onChangeTableTab,
  onChangeWhere,
  onApplyWhere,
  onReloadData,
  onPageData,
  onSortData,
}: Props) {
  const [filter, setFilter] = useState("");
  const [paneWidth, startResize] = useResizableWidth(260, 170, 520);
  /** 複数選択中のテーブルキー (エクスポート対象) */
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set());
  const [anchorIdx, setAnchorIdx] = useState<number | null>(null);
  const [dialog, setDialog] = useState<"export" | "import" | null>(null);
  /** テーブル一覧の再読み込み中か (アイコンの回転表示用) */
  const [reloading, setReloading] = useState(false);
  /** 新規テーブル名の入力中の値 (nullなら入力欄を出さない) */
  const [newTable, setNewTable] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** 作成・改名直後に選択したいテーブル (一覧に現れたら選ぶ) */
  const [pendingSelect, setPendingSelect] = useState<{
    schema?: string;
    name: string;
  } | null>(null);
  /** 名前を変更中のテーブル (キーと入力中の新しい名前) */
  const [renaming, setRenaming] = useState<{
    key: string;
    value: string;
  } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  /** 改名の二重実行防止 (Enterとフォーカスアウトが続けて起きるため) */
  const renameBusy = useRef(false);
  /** Escで抜けたときは、直後のフォーカスアウトで確定させない */
  const skipRenameBlur = useRef(false);
  /** SQLエディタの入力補完に使うテーブル・カラム名 */
  const [completionSchema, setCompletionSchema] = useState<SchemaMap>({});
  /** アプリ設定 (コメント区切り・入力補完) */
  const [settings, setSettings] = useState<AppSettings | null>(null);
  /** 削除の確認中のテーブル (nullなら確認していない) */
  const [dropping, setDropping] = useState<TableInfo | null>(null);
  /** テーブル項目の右クリックメニュー */
  const [tableMenu, setTableMenu] = useState<{
    x: number;
    y: number;
    table: TableInfo;
  } | null>(null);
  const { profile, databases, selectedDb, tables, loadingTables } = tab;

  // DB切替やテーブル一覧の更新で複数選択をリセット
  useEffect(() => {
    setMultiSel(new Set());
    setAnchorIdx(null);
  }, [selectedDb, tables]);

  // 作成したテーブルが一覧に現れたら選択して定義を表示する
  useEffect(() => {
    if (!pendingSelect) return;
    const found = tables.find(
      (t) =>
        t.name === pendingSelect.name &&
        (pendingSelect.schema === undefined || t.schema === pendingSelect.schema)
    );
    if (found) {
      setPendingSelect(null);
      setFilter("");
      onSelectTable(found);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables, pendingSelect]);

  // 設定を読む。設定モーダルでの変更 (イベント) と、
  // 別ウィンドウでの変更 (ウィンドウに戻ってきたとき) の両方で読み直す
  useEffect(() => {
    const load = () => {
      getAppSettings().then(setSettings).catch(() => {});
    };
    load();
    window.addEventListener(APP_SETTINGS_EVENT, load);
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener(APP_SETTINGS_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, []);

  const commentDelim = settings?.commentDelimiter ?? "（";

  // 入力補完に使うテーブル・カラムは、DBが変わったときに取り直す
  useEffect(() => {
    if (!selectedDb) {
      setCompletionSchema({});
      return;
    }
    let alive = true;
    schemaColumns(tab.key, selectedDb)
      .then((list) => {
        if (!alive) return;
        setCompletionSchema(
          Object.fromEntries(
            list.map((t) => [
              t.name,
              {
                logical: parseComment(t.comment ?? "", commentDelim)[0],
                columns: t.columns.map((c) => ({
                  name: c.name,
                  logical: parseComment(c.comment ?? "", commentDelim)[0],
                  dataType: c.dataType,
                })),
              },
            ])
          )
        );
      })
      // 補完は補助機能なので、取れなくても黙って諦める
      .catch(() => alive && setCompletionSchema({}));
    return () => {
      alive = false;
    };
  }, [tab.key, selectedDb, commentDelim]);

  // 右クリックメニューは外側クリック・リサイズで閉じる
  useEffect(() => {
    if (!tableMenu) return;
    const close = () => setTableMenu(null);
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
    };
  }, [tableMenu]);

  const filteredTables = useMemo(
    () =>
      tables.filter((t) =>
        tableKey(t).toLowerCase().includes(filter.toLowerCase())
      ),
    [tables, filter]
  );

  const showSchema = useMemo(
    () => new Set(tables.map((t) => t.schema ?? "")).size > 1,
    [tables]
  );

  const selected = tables.find((t) => tableKey(t) === tab.selectedTable) ?? null;

  /** テーブル項目クリック (⌘/Ctrl: トグル, Shift: 範囲, 通常: 単一選択+構造表示) */
  const handleTableClick = (
    e: React.MouseEvent,
    t: TableInfo,
    idx: number
  ) => {
    const key = tableKey(t);
    if (e.metaKey || e.ctrlKey) {
      setMultiSel((cur) => {
        const next = new Set(cur);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      setAnchorIdx(idx);
      return;
    }
    if (e.shiftKey && anchorIdx !== null) {
      const [from, to] = [Math.min(anchorIdx, idx), Math.max(anchorIdx, idx)];
      setMultiSel(
        new Set(filteredTables.slice(from, to + 1).map((x) => tableKey(x)))
      );
      return;
    }
    setMultiSel(new Set([key]));
    setAnchorIdx(idx);
    onSelectTable(t);
  };

  /** ⌘/Ctrl+A で表示中のテーブルを全選択 */
  const handlePaneKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setMultiSel(new Set(filteredTables.map((t) => tableKey(t))));
    }
  };

  /** テーブル一覧を取得し直す (二重実行しない) */
  const handleReloadTables = async () => {
    if (reloading || !selectedDb) return;
    setReloading(true);
    try {
      await onReloadTables();
    } finally {
      setReloading(false);
    }
  };

  /** 入力されたテーブル名で雛形テーブルを作る (確認は挟まない) */
  const handleCreateTable = async () => {
    const raw = (newTable ?? "").trim();
    if (!raw || creating || !selectedDb) return;
    // PostgreSQLだけは "スキーマ.テーブル" の指定を受け付ける
    let schema: string | undefined;
    let name = raw;
    if (profile.dbType === "postgresql" && raw.includes(".")) {
      const i = raw.indexOf(".");
      schema = raw.slice(0, i).trim();
      name = raw.slice(i + 1).trim();
    }
    setCreating(true);
    setCreateError(null);
    try {
      await createTable(tab.key, selectedDb, schema, name);
      setNewTable(null);
      setPendingSelect({ schema, name });
      await onReloadTables();
    } catch (e) {
      setCreateError(String(e));
    } finally {
      setCreating(false);
    }
  };

  /**
   * 入力された名前でテーブル名を変更する (確認は挟まない)。
   * Enterのほか、入力欄からフォーカスが外れたときにも確定する
   */
  const handleRenameTable = async (t: TableInfo) => {
    if (renameBusy.current) return;
    const next = (renaming?.value ?? "").trim();
    // 空欄や変更なしのときは、そのまま編集を閉じるだけにする
    if (!next || !selectedDb || next === t.name) {
      setRenaming(null);
      setRenameError(null);
      return;
    }
    renameBusy.current = true;
    setRenameError(null);
    try {
      await renameTable(tab.key, selectedDb, t.schema, t.name, next);
      setRenaming(null);
      setPendingSelect({ schema: t.schema, name: next });
      await onReloadTables();
    } catch (e) {
      setRenameError(String(e));
    } finally {
      renameBusy.current = false;
    }
  };

  /** SQLiteはファイルベースのため、ホスト表示や外部ツール連携の扱いが変わる */
  const isSqlite = profile.dbType === "sqlite";
  const dbFilePath = profile.database ?? "";

  /** エクスポート対象のテーブル名 (PGはschema付き) */
  const exportNames = useMemo(
    () =>
      tables
        .filter((t) => multiSel.has(tableKey(t)))
        .map((t) =>
          profile.dbType === "postgresql" && t.schema
            ? `${t.schema}.${t.name}`
            : t.name
        ),
    [tables, multiSel, profile.dbType]
  );

  return (
    <div className="session">
      {/* ツールバー */}
      <div className="session-toolbar">
        <span
          className={`db-badge ${profile.dbType}`}
          style={badgeStyle(profile.color)}
        >
          {dbBadgeLabel(profile.dbType)}
        </span>
        <div className="session-conn">
          <span className="session-name">{profile.name || "(無名)"}</span>
          <span className="session-host mono">
            {/* SQLiteはホスト:ポートではなくファイルパスを表示する */}
            {isSqlite ? (
              <span className="session-host-text" title={dbFilePath}>
                {dbFilePath}
              </span>
            ) : (
              <>
                {profile.ssh?.enabled && <span className="ssh-chip">SSH</span>}
                <span
                  className="session-host-text"
                  title={`${profile.host}:${profile.port}`}
                >
                  {profile.host}:{profile.port}
                </span>
              </>
            )}
          </span>
        </div>

        {/* SQLiteは1ファイル=1DBなので選択メニューは出さない */}
        {!isSqlite && (
          <div className="db-select-wrap">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <ellipse cx="12" cy="5.5" rx="8" ry="3" stroke="currentColor" strokeWidth="2" />
              <path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13" stroke="currentColor" strokeWidth="2" />
            </svg>
            <SelectMenu
              className="mono"
              value={selectedDb ?? ""}
              placeholder="データベースを選択"
              options={databases.map((d) => ({ value: d, label: d }))}
              onChange={onSelectDb}
            />
          </div>
        )}

        {tab.serverInfo.length > 0 && (
          <div className="server-info">
            {tab.serverInfo.map(([label, value]) => (
              <span className="info-chip" key={label} title={`${label}: ${value}`}>
                <span className="info-chip-label">{label}</span>
                <span className="info-chip-value mono">{value}</span>
              </span>
            ))}
          </div>
        )}

        <span className="toolbar-spacer" />
        <button
          className="sql-btn has-tooltip"
          data-tooltip="ER図 (テーブルのリレーションを別ウィンドウで表示・PNG出力)"
          onClick={() => {
            // DB未選択でも開ける (ER図ウィンドウ側で接続・DBを選べる)
            openEr(tab.key, selectedDb ?? "").catch(() => {});
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="3" y="3" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth="2" />
            <rect x="13" y="15" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth="2" />
            <path d="M7 9v6h6M17 15V9h-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          ER図
        </button>
        <button
          className="sql-btn has-tooltip"
          data-tooltip="スキーマ一覧 (テーブル/カラム/インデックスを別ウィンドウで表示・CSV出力)"
          disabled={!selectedDb}
          onClick={() => {
            if (selectedDb) {
              openSchema(tab.key, selectedDb, profile.name).catch(() => {});
            }
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M4 5h16M4 10h16M4 15h10M4 20h7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          一覧
        </button>
        <button
          className={"sql-btn" + (tab.view === "query" ? " active" : "")}
          title="SQLエディタ (⌘+Enterで実行)"
          onClick={onToggleQuery}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M5 5l7 7-7 7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M13 19h7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          SQL
        </button>
      </div>

      {tab.error && (
        <div className="result-banner ng session-error">
          <span className="dot" aria-hidden />
          <strong>エラー</strong>
          <span className="result-detail">{tab.error}</span>
        </div>
      )}

      {/* 本体 */}
      <div className="session-body">
        <aside
          className="table-pane"
          style={{ width: paneWidth }}
          tabIndex={0}
          onKeyDown={handlePaneKeyDown}
        >
          <div className="table-pane-head">
            <span>テーブル</span>
            {selectedDb && !loadingTables && (
              <span className="panel-count">
                {multiSel.size > 1
                  ? `${multiSel.size}/${tables.length}`
                  : tables.length}
              </span>
            )}
            <button
              className={
                "pane-icon-btn has-tooltip tooltip-left" +
                (reloading ? " spinning" : "")
              }
              data-tooltip="テーブル一覧を再読み込み"
              disabled={!selectedDb || loadingTables || reloading}
              onClick={handleReloadTables}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              className="pane-icon-btn has-tooltip tooltip-left"
              data-tooltip="テーブルを新規作成 (主キーidのみの雛形を作ります)"
              disabled={!selectedDb || loadingTables || creating}
              onClick={() => {
                setCreateError(null);
                setNewTable("");
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <span className="toolbar-spacer" />
            {/* エクスポート/インポートは外部ツール(mysqldump等)を使うためSQLiteでは出さない */}
            {!isSqlite && (
              <>
            <button
              className="pane-icon-btn has-tooltip tooltip-left"
              data-tooltip="選択テーブルをエクスポート (⌘クリックで複数選択 / ⌘Aで全選択)"
              disabled={!selectedDb || multiSel.size === 0}
              onClick={() => setDialog("export")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 20h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
            <button
              className="pane-icon-btn has-tooltip tooltip-left"
              data-tooltip="SQLファイルをインポート"
              disabled={!selectedDb}
              onClick={() => setDialog("import")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 20h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
              </>
            )}
          </div>
          {newTable !== null && (
            <div className="new-table-row">
              <div className="new-table-input">
                {creating ? (
                  <span className="spinner accent" />
                ) : (
                  <span className="new-table-mark" aria-hidden>
                    +
                  </span>
                )}
                <input
                  className="mono"
                  autoFocus
                  disabled={creating}
                  value={newTable}
                  placeholder={
                    profile.dbType === "postgresql"
                      ? "テーブル名 (schema.name も可)"
                      : "テーブル名"
                  }
                  onChange={(e) => setNewTable(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreateTable();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setNewTable(null);
                      setCreateError(null);
                    }
                  }}
                />
              </div>
              {createError ? (
                <p className="new-table-error">{createError}</p>
              ) : (
                <p className="new-table-hint">
                  Enterで作成 / Escで取り消し
                </p>
              )}
            </div>
          )}
          {!selectedDb ? (
            <div className="table-pane-empty">上部からデータベースを選択</div>
          ) : loadingTables ? (
            <div className="table-pane-empty">
              <span className="spinner accent" /> 読み込み中...
            </div>
          ) : (
            <>
              <input
                className="filter-input mono"
                placeholder="絞り込み..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <ul className="side-table-list">
                {filteredTables.map((t, idx) => {
                  const badge = typeLabel(t.tableType);
                  const key = tableKey(t);
                  // 名前を変更中の行は、その場で入力欄に差し替える
                  if (renaming?.key === key) {
                    return (
                      <li key={key}>
                        <div className="rename-table-row">
                          <span className={`type-chip mini ${badge.cls}`}>
                            {badge.label}
                          </span>
                          <input
                            className="mono"
                            autoFocus
                            value={renaming.value}
                            onChange={(e) =>
                              setRenaming({ key, value: e.target.value })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleRenameTable(t);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                skipRenameBlur.current = true;
                                setRenaming(null);
                                setRenameError(null);
                              }
                            }}
                            // 別の場所をクリックしたときも確定する
                            // (失敗表示が出ているときは直してもらうため何もしない)
                            onBlur={() => {
                              if (skipRenameBlur.current) {
                                skipRenameBlur.current = false;
                                return;
                              }
                              if (renameError) return;
                              handleRenameTable(t);
                            }}
                          />
                        </div>
                        {renameError && (
                          <p className="new-table-error">{renameError}</p>
                        )}
                      </li>
                    );
                  }
                  return (
                    <li key={key}>
                      <button
                        className={
                          "side-table-item" +
                          (tab.selectedTable === key ? " selected" : "") +
                          (multiSel.has(key) ? " multi" : "")
                        }
                        onClick={(e) => handleTableClick(e, t, idx)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setRenameError(null);
                          setTableMenu({ x: e.clientX, y: e.clientY, table: t });
                        }}
                        // MySQLはschemaが無いため、keyそのまま (".table名") ではなく表示用の名前を出す
                        title={t.schema ? `${t.schema}.${t.name}` : t.name}
                      >
                        <span className={`type-chip mini ${badge.cls}`}>
                          {badge.label}
                        </span>
                        <span className="side-table-name mono">
                          {showSchema && t.schema && (
                            <span className="table-schema">{t.schema}.</span>
                          )}
                          {t.name}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {filteredTables.length === 0 && (
                  <li className="table-pane-empty">
                    {tables.length === 0 ? "テーブルなし" : "該当なし"}
                  </li>
                )}
              </ul>
            </>
          )}
        </aside>

        <div className="pane-splitter" onMouseDown={startResize} />

        <main className="session-content">
          {tab.view === "query" ? (
            <QueryPanel
              sessionId={tab.key}
              database={selectedDb ?? undefined}
              dbType={profile.dbType}
              sql={tab.sql}
              results={tab.queryResults}
              error={tab.queryError}
              running={tab.runningQuery}
              runStartedAt={tab.runStartedAt}
              explainKind={tab.queryExplain}
              columnTips={tab.columnTips}
              schema={completionSchema}
              autocomplete={settings?.autocompleteEnabled ?? true}
              autocompleteDelayMs={settings?.autocompleteDelayMs ?? 100}
              onChangeSql={onChangeSql}
              onRun={onRunQuery}
              onCancel={onCancelQuery}
              onPage={onPageQuery}
              onServerSort={onSortQuery}
            />
          ) : selected ? (
            <TableView
              table={selected}
              sessionId={tab.key}
              database={selectedDb ?? undefined}
              dbType={profile.dbType}
              onReloadDetail={onReloadDetail}
              onSendToEditor={onSendToEditor}
              view={tab.tableTab}
              onChangeView={onChangeTableTab}
              detail={tab.tableDetail}
              loadingDetail={tab.loadingDetail}
              data={tab.tableData}
              loadingData={tab.loadingData}
              dataError={tab.dataError}
              where={tab.dataWhere}
              onChangeWhere={onChangeWhere}
              onApplyWhere={onApplyWhere}
              onReloadData={onReloadData}
              onPageData={onPageData}
              onSortData={onSortData}
            />
          ) : (
            <div className="content-placeholder dim-center">
              {selectedDb
                ? "左の一覧からテーブルを選択してください"
                : "データベースを選択するとテーブル一覧が表示されます"}
            </div>
          )}
        </main>
      </div>

      {dialog === "export" && selectedDb && (
        <ExportDialog
          sessionId={tab.key}
          database={selectedDb}
          connName={profile.name || profile.host}
          tables={exportNames}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "import" && selectedDb && (
        <ImportDialog
          sessionId={tab.key}
          database={selectedDb}
          connName={profile.name || profile.host}
          onClose={() => setDialog(null)}
          onImported={() => onSelectDb(selectedDb)}
        />
      )}

      {/* テーブル項目の右クリックメニュー */}
      {tableMenu &&
        createPortal(
          <div
            className="context-menu"
            style={{ left: tableMenu.x, top: tableMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="grid-sort-head mono">{tableMenu.table.name}</div>
            <button
              className="context-item"
              disabled={tableMenu.table.tableType.toUpperCase().includes("VIEW")}
              onClick={() => {
                const t = tableMenu.table;
                setTableMenu(null);
                setRenaming({ key: tableKey(t), value: t.name });
              }}
            >
              テーブル名を変更
            </button>
            <button
              className="context-item"
              onClick={() => {
                setTableMenu(null);
                setCreateError(null);
                setNewTable("");
              }}
            >
              テーブルを新規作成
            </button>
            <button
              className="context-item danger"
              onClick={() => {
                const t = tableMenu.table;
                setTableMenu(null);
                setDropping(t);
              }}
            >
              テーブルを削除
            </button>
          </div>,
          document.body
        )}

      {dropping && (
        <DropTableConfirm
          sessionId={tab.key}
          database={selectedDb ?? undefined}
          table={dropping}
          onClose={() => setDropping(null)}
          onDropped={() => {
            void onReloadTables();
          }}
        />
      )}
    </div>
  );
}
