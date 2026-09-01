import { useEffect, useMemo, useState } from "react";
import { isCancelled, LoadingWithCancel } from "./LoadingWithCancel";
import { RevealButton } from "./RevealButton";
import {
  exportSchemaCsv,
  exportSchemaXlsx,
  getAppSettings,
  listSessions,
  schemaSnapshot,
} from "../api";
import { TablePicker } from "./TablePicker";
import { parseComment } from "../comment";
import { usePolling } from "../hooks/usePolling";
import type { SchemaEntry, SessionSummary, TableInfo } from "../types";
import { GridColumn, ResizableGrid } from "./ResizableGrid";

function fullName(t: TableInfo): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

function infoGet(info: [string, string][], label: string): string {
  return info.find(([l]) => l === label)?.[1] ?? "";
}

/** "varchar(100)" → ["varchar", "100"] */
function splitType(t: string): [string, string] {
  const m = t.match(/^([^(]+)\(([^)]*)\)(.*)$/);
  if (!m) return [t, ""];
  return [`${m[1]}${m[3] ?? ""}`.trim(), m[2]];
}


const TABLE_COLS: GridColumn[] = [
  { id: "name", label: "テーブル名", width: 220, minWidth: 100 },
  { id: "type", label: "種別", width: 100, minWidth: 60 },
  { id: "rows", label: "概算行数", width: 90, minWidth: 60, align: "right" },
  { id: "engine", label: "エンジン", width: 90, minWidth: 60 },
  { id: "size", label: "サイズ", width: 90, minWidth: 60, align: "right" },
  { id: "collation", label: "照合順序", width: 170, minWidth: 80 },
  { id: "created", label: "作成", width: 150, minWidth: 80 },
  { id: "updated", label: "更新", width: 150, minWidth: 80 },
  { id: "comment", label: "コメント", width: 240, minWidth: 100, wrap: true },
];

const COLUMN_COLS: GridColumn[] = [
  { id: "table", label: "テーブル名", width: 180, minWidth: 90 },
  { id: "tcomment", label: "テーブルコメント", width: 150, minWidth: 80 },
  { id: "no", label: "No", width: 46, minWidth: 40, align: "right" },
  { id: "logical", label: "論理名", width: 150, minWidth: 80 },
  { id: "name", label: "カラム名", width: 180, minWidth: 90 },
  { id: "type", label: "型", width: 100, minWidth: 60 },
  { id: "size", label: "サイズ", width: 70, minWidth: 50, align: "right" },
  { id: "notnull", label: "NOT NULL", width: 80, minWidth: 60, align: "center" },
  { id: "key", label: "キー", width: 60, minWidth: 44, align: "center" },
  { id: "default", label: "デフォルト", width: 130, minWidth: 60 },
  { id: "extra", label: "属性", width: 120, minWidth: 60 },
  { id: "collation", label: "照合順序", width: 160, minWidth: 80 },
  { id: "note", label: "補足", width: 220, minWidth: 100, wrap: true },
];

const INDEX_COLS: GridColumn[] = [
  { id: "table", label: "テーブル名", width: 220, minWidth: 90 },
  { id: "no", label: "No", width: 46, minWidth: 40, align: "right" },
  { id: "name", label: "インデックス名", width: 220, minWidth: 100 },
  { id: "column", label: "カラム名", width: 220, minWidth: 100 },
  { id: "unique", label: "ユニーク", width: 80, minWidth: 60, align: "center" },
];

/** スキーマ一覧ウィンドウ */
export function SchemaWindow() {
  const params = new URLSearchParams(window.location.search);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  // 対象の接続/DBは開いた画面で選択済みのものに固定 (この画面では変更しない)
  const [sel] = useState({
    sessionId: params.get("session") ?? "",
    database: params.get("db") ?? "",
  });
  const [entries, setEntries] = useState<SchemaEntry[] | null>(null);
  const [view, setView] = useState<"tables" | "columns" | "indexes">("columns");
  const [filter, setFilter] = useState("");
  /** 論理名と補足の区切り文字 (設定から読み込む) */
  const [delim, setDelim] = useState("（");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshSessions = async () => {
    try {
      setSessions(await listSessions());
    } catch {
      /* 無視 */
    }
  };

  // ウィンドウが隠れている間は止める
  usePolling(refreshSessions, 3000);

  const load = async (sessionId: string, database: string) => {
    if (!sessionId || !database) return;
    setLoading(true);
    setError(null);
    try {
      setEntries(await schemaSnapshot(sessionId, database));
    } catch (e) {
      setError(String(e));
      setEntries(null);
    } finally {
      setLoading(false);
    }
  };

  // 起動パラメータがあれば自動読み込み + 区切り文字設定の取得
  useEffect(() => {
    getAppSettings()
      .then((s) => setDelim(s.commentDelimiter))
      .catch(() => {});
    load(sel.sessionId, sel.database);
    // 起動時に1回だけ (load は毎回作り直されるので依存に入れない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 直近に保存したファイル (「フォルダを開く」の対象) */
  const [savedPath, setSavedPath] = useState<string | null>(null);
  /** 定義書に入れるテーブルを選ぶ画面を出しているか */
  const [picking, setPicking] = useState(false);

  /** 選んだテーブルでExcelの定義書を書き出す */
  const handleExportXlsx = async (tables: string[]) => {
    if (!sel.sessionId || !sel.database || exporting) return;
    setPicking(false);
    setExporting(true);
    setNotice(null);
    setError(null);
    try {
      const path = await exportSchemaXlsx(
        sel.sessionId,
        sel.database,
        connName,
        tables
      );
      setNotice(`${path.split("/").pop()} を保存しました: ${path}`);
      setSavedPath(path);
      setTimeout(() => setNotice(null), 10000);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  };

  const handleExport = async () => {
    if (!sel.sessionId || !sel.database || exporting) return;
    setExporting(true);
    setNotice(null);
    setError(null);
    try {
      const paths = await exportSchemaCsv(sel.sessionId, sel.database);
      const names = paths.map((p) => p.split("/").pop()).join(" / ");
      setNotice(`${names} を保存しました: ${paths[0] ?? ""}`);
      setSavedPath(paths[0] ?? null);
      setTimeout(() => setNotice(null), 10000);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  };

  const session = sessions.find((s) => s.sessionId === sel.sessionId);
  // 接続名は起動パラメータで渡されるため、読み込み中でもはじめから表示できる
  // (パラメータが無い場合のみセッション一覧から補完する)
  const connName = params.get("name") || session?.name || "接続";
  const f = filter.toLowerCase();

  // ---------- 行データ ----------

  const tableRows = useMemo(
    () =>
      (entries ?? [])
        .filter((e) => fullName(e.table).toLowerCase().includes(f))
        .map((e) => ({
          key: fullName(e.table),
          cells: [
            <span className="mono strong">{fullName(e.table)}</span>,
            <span className="dim">{e.table.tableType}</span>,
            <span className="mono dim">
              {e.table.rowEstimate?.toLocaleString() ?? ""}
            </span>,
            <span className="dim">{infoGet(e.detail.info, "エンジン")}</span>,
            <span className="mono dim">{infoGet(e.detail.info, "サイズ")}</span>,
            <span className="mono faint">
              {infoGet(e.detail.info, "照合順序")}
            </span>,
            <span className="mono faint">{infoGet(e.detail.info, "作成")}</span>,
            <span className="mono faint">{infoGet(e.detail.info, "更新")}</span>,
            <span className="comment-text">
              {infoGet(e.detail.info, "コメント")}
            </span>,
          ],
        })),
    [entries, f]
  );

  const columnRows = useMemo(
    () =>
      (entries ?? []).flatMap((e) => {
        const tname = fullName(e.table);
        const tcomment = infoGet(e.detail.info, "コメント");
        return e.detail.columns
          .map((c, i) => ({ c, i }))
          .filter(
            ({ c }) =>
              !f ||
              tname.toLowerCase().includes(f) ||
              c.name.toLowerCase().includes(f) ||
              (c.comment ?? "").toLowerCase().includes(f)
          )
          .map(({ c, i }) => {
            const [base, size] = splitType(c.colType);
            const [logical, note] = parseComment(c.comment ?? "", delim);
            return {
              key: `${tname}.${c.name}`,
              cells: [
                <span className="mono dim">{tname}</span>,
                <span className="dim">{tcomment}</span>,
                <span className="mono faint">{i + 1}</span>,
                <span>{logical}</span>,
                <span className="mono strong">{c.name}</span>,
                <span className="mono dim">{base}</span>,
                <span className="mono dim">{size}</span>,
                c.nullable ? null : <span className="check">○</span>,
                c.key ? (
                  <span
                    className={"key-badge" + (c.key === "PRI" ? " pri" : "")}
                  >
                    {c.key}
                  </span>
                ) : null,
                <span className="mono dim">
                  {c.default === null || c.default === undefined
                    ? ""
                    : c.default === ""
                      ? "''"
                      : c.default}
                </span>,
                <span className="dim">{c.extra ?? ""}</span>,
                <span className="mono faint">{c.collation ?? ""}</span>,
                <span className="comment-text">{note}</span>,
              ],
            };
          });
      }),
    [entries, f, delim]
  );

  const indexRows = useMemo(
    () =>
      (entries ?? []).flatMap((e) => {
        const tname = fullName(e.table);
        return e.detail.indexes.flatMap((ix) =>
          ix.columns
            .split(",")
            .map((col) => col.trim())
            .map((col, seq) => ({ ix, col, seq }))
            .filter(
              ({ ix, col }) =>
                !f ||
                tname.toLowerCase().includes(f) ||
                ix.name.toLowerCase().includes(f) ||
                col.toLowerCase().includes(f)
            )
            .map(({ ix, col, seq }) => ({
              key: `${tname}.${ix.name}.${seq}`,
              cells: [
                <span className="mono dim">{tname}</span>,
                <span className="mono faint">{seq + 1}</span>,
                <span className="mono strong">{ix.name}</span>,
                <span className="mono">{col}</span>,
                ix.unique ? <span className="check">◯</span> : null,
              ],
            }))
        );
      }),
    [entries, f]
  );

  const counts = useMemo(
    () => ({
      tables: (entries ?? []).length,
      columns: (entries ?? []).reduce(
        (sum, e) => sum + e.detail.columns.length,
        0
      ),
      indexes: (entries ?? []).reduce(
        (sum, e) =>
          sum +
          e.detail.indexes.reduce(
            (s2, ix) => s2 + ix.columns.split(",").length,
            0
          ),
        0
      ),
    }),
    [entries]
  );

  return (
    <div className="schema-window">
      <div className="diff-toolbar" data-tauri-drag-region>
        {/* 開いた画面で選択済みの接続/DBを対象にするため、ここでは変更できない */}
        <div className="diff-side-sel schema-target">
          <span className="schema-target-name">{connName}</span>
          <span className="schema-target-sep">/</span>
          <span className="mono schema-target-db">{sel.database}</span>
        </div>

        <input
          className="filter-input mono schema-filter"
          placeholder="絞り込み (テーブル / カラム / コメント)..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        <button
          className="btn-secondary diff-compare"
          onClick={() => setPicking(true)}
          disabled={exporting || !entries}
          title="表紙・テーブル一覧・テーブルごとのシートを作ります"
        >
          Excel定義書
        </button>

        <button
          className="btn-primary diff-compare"
          onClick={handleExport}
          disabled={exporting || !entries}
        >
          {exporting ? (
            <>
              <span className="spinner light" /> 出力中...
            </>
          ) : (
            "CSVダウンロード"
          )}
        </button>
      </div>

      {error && (
        <div
          className={`result-banner ${isCancelled(error) ? "ok" : "ng"} diff-error`}
        >
          <span className="dot" aria-hidden />
          <strong>{isCancelled(error) ? "中止" : "エラー"}</strong>
          <span className="result-detail">{error}</span>
        </div>
      )}
      {notice && (
        <div className="result-banner ok diff-error">
          <span className="dot" aria-hidden />
          <strong>出力</strong>
          <span className="result-detail">{notice}</span>
          {savedPath && (
            <>
              <span className="toolbar-spacer" />
              <RevealButton path={savedPath} />
            </>
          )}
        </div>
      )}

      {loading ? (
        <LoadingWithCancel
          label="スキーマを読み込み中..."
          sessionIds={[sel.sessionId]}
          dbTypes={[sessions.find((s) => s.sessionId === sel.sessionId)?.dbType]}
        />
      ) : !entries ? (
        <div className="content-placeholder dim-center">
          {sessions.length === 0
            ? "開いている接続がありません (メイン画面でデータベースに接続してください)"
            : "上の選択欄から接続とデータベースを選ぶと、一覧を読み込みます"}
        </div>
      ) : (
        <div className="schema-body">
          <div className="result-tabs diff-view-tabs">
            {(
              [
                ["tables", "テーブル", counts.tables],
                ["columns", "カラム", counts.columns],
                ["indexes", "インデックス", counts.indexes],
              ] as const
            ).map(([v, label, count]) => (
              <button
                key={v}
                className={"result-tab" + (view === v ? " active" : "")}
                onClick={() => setView(v)}
              >
                {label} ({count})
              </button>
            ))}
          </div>
          <div className="schema-grid">
            {view === "tables" && (
              <ResizableGrid
                columns={TABLE_COLS}
                rows={tableRows}
                emptyText="該当なし"
              />
            )}
            {view === "columns" && (
              <ResizableGrid
                columns={COLUMN_COLS}
                rows={columnRows}
                emptyText="該当なし"
              />
            )}
            {view === "indexes" && (
              <ResizableGrid
                columns={INDEX_COLS}
                rows={indexRows}
                emptyText="該当なし"
              />
            )}
          </div>
        </div>
      )}

      {picking && entries && (
        <TablePicker
          tables={entries.map((e) => e.table)}
          initial={new Set(entries.map((e) => e.table.name))}
          existing={new Set()}
          title="定義書に入れるテーブルを選ぶ"
          submitLabel={(n) => (n > 0 ? `${n}件で出力` : "出力")}
          note="選んだテーブルごとに1シートを作ります。表紙とテーブル一覧は必ず付きます"
          target={`${connName} / ${sel.database}`}
          loading={false}
          onClose={() => setPicking(false)}
          onSubmit={(names) => void handleExportXlsx([...names])}
        />
      )}
    </div>
  );
}
