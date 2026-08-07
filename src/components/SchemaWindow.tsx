import { useEffect, useMemo, useState } from "react";
import { exportSchemaCsv, getAppSettings, listSessions, schemaSnapshot } from "../api";
import { parseComment } from "../comment";
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
  const [sel, setSel] = useState({
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

  useEffect(() => {
    refreshSessions();
    const timer = setInterval(refreshSessions, 3000);
    return () => clearInterval(timer);
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleExport = async () => {
    if (!sel.sessionId || !sel.database || exporting) return;
    setExporting(true);
    setNotice(null);
    setError(null);
    try {
      const paths = await exportSchemaCsv(sel.sessionId, sel.database);
      const names = paths.map((p) => p.split("/").pop()).join(" / ");
      setNotice(`ダウンロードフォルダに保存しました: ${names}`);
      setTimeout(() => setNotice(null), 10000);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  };

  const session = sessions.find((s) => s.sessionId === sel.sessionId);
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
        <div className="diff-side-sel">
          <select
            className="db-select mono"
            value={sel.sessionId}
            onChange={(e) => {
              const s = sessions.find((x) => x.sessionId === e.target.value);
              const db = s?.currentDb ?? s?.databases[0] ?? "";
              setSel({ sessionId: e.target.value, database: db });
              load(e.target.value, db);
            }}
          >
            <option value="" disabled>
              接続を選択
            </option>
            {sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            className="db-select mono"
            value={sel.database}
            disabled={!session}
            onChange={(e) => {
              setSel({ ...sel, database: e.target.value });
              load(sel.sessionId, e.target.value);
            }}
          >
            {(session?.databases ?? [sel.database]).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>

        <input
          className="filter-input mono schema-filter"
          placeholder="絞り込み (テーブル / カラム / コメント)..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

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
        <div className="result-banner ng diff-error">
          <span className="dot" aria-hidden />
          <strong>エラー</strong>
          <span className="result-detail">{error}</span>
        </div>
      )}
      {notice && (
        <div className="result-banner ok diff-error">
          <span className="dot" aria-hidden />
          <strong>CSV出力</strong>
          <span className="result-detail">{notice}</span>
        </div>
      )}

      {loading ? (
        <div className="content-placeholder dim-center">
          <span className="spinner accent" /> スキーマを読み込み中...
        </div>
      ) : !entries ? (
        <div className="content-placeholder dim-center">
          接続とデータベースを選択してください
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
    </div>
  );
}
