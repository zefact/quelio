import { useEffect, useMemo, useState } from "react";
import { openEr, openSchema } from "../api";
import { badgeStyle } from "../colors";
import { useResizableWidth } from "../hooks/useResizableWidth";
import type { TableInfo, WorkTab } from "../types";
import { QueryPanel } from "./QueryPanel";
import { SelectMenu } from "./SelectMenu";
import { StructureView } from "./StructureView";
import { ExportDialog, ImportDialog } from "./TransferDialog";

interface Props {
  tab: WorkTab;
  onSelectDb: (db: string) => void;
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
}

function typeLabel(t: string): { label: string; cls: string } {
  if (t === "VIEW") return { label: "V", cls: "view" };
  if (t === "MATERIALIZED VIEW") return { label: "MV", cls: "view" };
  if (t === "FOREIGN TABLE") return { label: "F", cls: "view" };
  return { label: "T", cls: "table" };
}

function tableKey(t: TableInfo): string {
  return `${t.schema ?? ""}.${t.name}`;
}

/** 接続済みタブの中身: 上部DBセレクタ + 左テーブル一覧 + コンテンツ領域 */
export function SessionView({
  tab,
  onSelectDb,
  onSelectTable,
  onToggleQuery,
  onChangeSql,
  onRunQuery,
  onCancelQuery,
  onPageQuery,
  onSortQuery,
}: Props) {
  const [filter, setFilter] = useState("");
  const [paneWidth, startResize] = useResizableWidth(260, 170, 520);
  /** 複数選択中のテーブルキー (エクスポート対象) */
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set());
  const [anchorIdx, setAnchorIdx] = useState<number | null>(null);
  const [dialog, setDialog] = useState<"export" | "import" | null>(null);
  const { profile, databases, selectedDb, tables, loadingTables } = tab;

  // DB切替やテーブル一覧の更新で複数選択をリセット
  useEffect(() => {
    setMultiSel(new Set());
    setAnchorIdx(null);
  }, [selectedDb, tables]);

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
          {profile.dbType === "mysql" ? "My" : "Pg"}
        </span>
        <div className="session-conn">
          <span className="session-name">{profile.name || "(無名)"}</span>
          <span className="session-host mono">
            {profile.ssh?.enabled && <span className="ssh-chip">SSH</span>}
            <span
              className="session-host-text"
              title={`${profile.host}:${profile.port}`}
            >
              {profile.host}:{profile.port}
            </span>
          </span>
        </div>

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
            if (selectedDb) openSchema(tab.key, selectedDb).catch(() => {});
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
            <span className="toolbar-spacer" />
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
          </div>
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
                  return (
                    <li key={key}>
                      <button
                        className={
                          "side-table-item" +
                          (tab.selectedTable === key ? " selected" : "") +
                          (multiSel.has(key) ? " multi" : "")
                        }
                        onClick={(e) => handleTableClick(e, t, idx)}
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
              dbType={profile.dbType}
              sql={tab.sql}
              results={tab.queryResults}
              error={tab.queryError}
              running={tab.runningQuery}
              runStartedAt={tab.runStartedAt}
              explainKind={tab.queryExplain}
              onChangeSql={onChangeSql}
              onRun={onRunQuery}
              onCancel={onCancelQuery}
              onPage={onPageQuery}
              onServerSort={onSortQuery}
            />
          ) : selected ? (
            <StructureView
              table={selected}
              detail={tab.tableDetail}
              loading={tab.loadingDetail}
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
    </div>
  );
}
