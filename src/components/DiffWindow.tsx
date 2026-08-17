import { useEffect, useMemo, useState } from "react";
import { listSessions, schemaSnapshot } from "../api";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { SelectMenu } from "./SelectMenu";
import type {
  ColumnInfo,
  IndexInfo,
  SchemaEntry,
  SessionSummary,
} from "../types";

/** 片側の選択 (セッション×DB) */
interface SideSel {
  sessionId: string;
  database: string;
}

interface FieldDiff {
  label: string;
  left?: string;
  right?: string;
}

interface ItemDiff {
  name: string;
  status: "added" | "removed" | "changed";
  fields: FieldDiff[];
}

interface TableDiff {
  key: string;
  status: "added" | "removed" | "changed" | "same";
  attrs: FieldDiff[];
  columns: ItemDiff[];
  indexes: ItemDiff[];
}

function tableKey(e: SchemaEntry): string {
  const t = e.table;
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

/** カラム属性の比較対象 */
function columnFields(c: ColumnInfo): [string, string][] {
  return [
    ["型", c.colType],
    ["NULL許可", c.nullable ? "YES" : "NO"],
    ["キー", c.key ?? ""],
    ["デフォルト", c.default ?? ""],
    ["属性", c.extra ?? ""],
    ["照合順序", c.collation ?? ""],
    ["コメント", c.comment ?? ""],
  ];
}

function indexFields(ix: IndexInfo): [string, string][] {
  return [
    ["カラム", ix.columns],
    ["ユニーク", ix.unique ? "YES" : "NO"],
    ["種別", ix.indexType ?? ""],
  ];
}

/** テーブル情報のうち比較する項目 (サイズ・行数・日時は除外) */
const TABLE_INFO_LABELS = ["エンジン", "照合順序", "コメント"];

function diffNamedItems<T>(
  left: Map<string, T>,
  right: Map<string, T>,
  fieldsOf: (v: T) => [string, string][]
): ItemDiff[] {
  const out: ItemDiff[] = [];
  const names = new Set([...left.keys(), ...right.keys()]);
  for (const name of names) {
    const l = left.get(name);
    const r = right.get(name);
    if (l && !r) {
      out.push({ name, status: "removed", fields: [] });
    } else if (!l && r) {
      out.push({ name, status: "added", fields: [] });
    } else if (l && r) {
      const lf = fieldsOf(l);
      const rf = fieldsOf(r);
      const fields: FieldDiff[] = [];
      for (let i = 0; i < lf.length; i++) {
        if (lf[i][1] !== rf[i][1]) {
          fields.push({ label: lf[i][0], left: lf[i][1], right: rf[i][1] });
        }
      }
      if (fields.length > 0) {
        out.push({ name, status: "changed", fields });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 2つのスナップショットの差分を計算する */
function computeDiff(left: SchemaEntry[], right: SchemaEntry[]): TableDiff[] {
  const lMap = new Map(left.map((e) => [tableKey(e), e]));
  const rMap = new Map(right.map((e) => [tableKey(e), e]));
  const keys = [...new Set([...lMap.keys(), ...rMap.keys()])].sort();

  return keys.map((key) => {
    const l = lMap.get(key);
    const r = rMap.get(key);
    if (l && !r) {
      return { key, status: "removed" as const, attrs: [], columns: [], indexes: [] };
    }
    if (!l && r) {
      return { key, status: "added" as const, attrs: [], columns: [], indexes: [] };
    }
    const le = l!;
    const re = r!;

    // テーブル属性
    const attrs: FieldDiff[] = [];
    if (le.table.tableType !== re.table.tableType) {
      attrs.push({
        label: "種別",
        left: le.table.tableType,
        right: re.table.tableType,
      });
    }
    for (const label of TABLE_INFO_LABELS) {
      const lv = le.detail.info.find(([l2]) => l2 === label)?.[1] ?? "";
      const rv = re.detail.info.find(([l2]) => l2 === label)?.[1] ?? "";
      if (lv !== rv) attrs.push({ label, left: lv, right: rv });
    }

    const columns = diffNamedItems(
      new Map(le.detail.columns.map((c) => [c.name, c])),
      new Map(re.detail.columns.map((c) => [c.name, c])),
      columnFields
    );
    const indexes = diffNamedItems(
      new Map(le.detail.indexes.map((ix) => [ix.name, ix])),
      new Map(re.detail.indexes.map((ix) => [ix.name, ix])),
      indexFields
    );

    const status =
      attrs.length + columns.length + indexes.length > 0 ? "changed" : "same";
    return { key, status, attrs, columns, indexes } as TableDiff;
  });
}

/** 共通prefix/suffixを除いた差異部分を求める */
function splitDiff(a: string, b: string): [string, string, string] {
  const aa = [...a];
  const bb = [...b];
  let p = 0;
  while (p < aa.length && p < bb.length && aa[p] === bb[p]) p++;
  let s = 0;
  while (
    s < aa.length - p &&
    s < bb.length - p &&
    aa[aa.length - 1 - s] === bb[bb.length - 1 - s]
  )
    s++;
  return [
    aa.slice(0, p).join(""),
    aa.slice(p, aa.length - s).join(""),
    aa.slice(aa.length - s).join(""),
  ];
}

/** スペースを可視化 (半角→␣ / 全角→□) */
function visualizeWs(s: string): string {
  return s.replace(/ /g, "␣").replace(/　/g, "□");
}

/** 差異部分のUnicodeコードポイント一覧 */
function codePoints(s: string): string {
  return [...s]
    .map((c) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"))
    .join(" ");
}

/** 相手側との差異部分をハイライトして描画 */
function DiffValue({ value, other }: { value?: string; other?: string }) {
  const v = value ?? "";
  const o = other ?? "";
  if (v === "" || v === o) return <>{v || "—"}</>;
  const [prefix, mid, suffix] = splitDiff(v, o);
  if (mid === "") {
    // この側には無い文字が相手側にある (挿入位置を示す)
    return (
      <>
        {prefix}
        <span className="char-diff empty-mark" title="この位置に相手側のみ文字があります">
          ‸
        </span>
        {suffix}
      </>
    );
  }
  return (
    <>
      {prefix}
      <span className="char-diff" title={`差異部分: "${mid}" (${codePoints(mid)})`}>
        {visualizeWs(mid)}
      </span>
      {suffix}
    </>
  );
}

const STATUS_LABEL: Record<TableDiff["status"], string> = {
  added: "右のみ",
  removed: "左のみ",
  changed: "差異あり",
  same: "一致",
};

/** スキーマ差分ウィンドウ */
export function DiffWindow() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [left, setLeft] = useState<SideSel>({ sessionId: "", database: "" });
  const [right, setRight] = useState<SideSel>({ sessionId: "", database: "" });
  const [diff, setDiff] = useState<TableDiff[] | null>(null);
  const [activeView, setActiveView] = useState<"tables" | "columns" | "indexes">(
    "tables"
  );
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 項目カラムの幅 (ヘッダのハンドルでドラッグ変更)
  const [labelWidth, startLabelResize] = useResizableWidth(220, 120, 600);

  const refreshSessions = async () => {
    try {
      // Valkeyはスキーマの概念が無いため差分の対象から除外する
      setSessions(
        (await listSessions()).filter((s) => s.dbType !== "valkey")
      );
    } catch {
      /* 無視 */
    }
  };

  useEffect(() => {
    refreshSessions();
    const timer = setInterval(refreshSessions, 3000);
    return () => clearInterval(timer);
  }, []);

  const sideSelector = (
    side: SideSel,
    setSide: (s: SideSel) => void,
    placeholder: string
  ) => {
    const session = sessions.find((s) => s.sessionId === side.sessionId);
    return (
      <div className="diff-side-sel">
        <SelectMenu
          className="mono"
          value={side.sessionId}
          placeholder={placeholder}
          options={sessions.map((s) => ({
            value: s.sessionId,
            label: s.name,
          }))}
          onChange={(v) => {
            const s = sessions.find((x) => x.sessionId === v);
            setSide({
              sessionId: v,
              database: s?.currentDb ?? s?.databases[0] ?? "",
            });
          }}
        />
        <SelectMenu
          className="mono"
          value={side.database}
          placeholder="データベース"
          disabled={!session}
          options={(session?.databases ?? []).map((d) => ({
            value: d,
            label: d,
          }))}
          onChange={(v) => setSide({ ...side, database: v })}
        />
      </div>
    );
  };

  const handleCompare = async () => {
    if (!left.sessionId || !left.database || !right.sessionId || !right.database)
      return;
    setLoading(true);
    setError(null);
    setDiff(null);
    try {
      const [l, r] = await Promise.all([
        schemaSnapshot(left.sessionId, left.database),
        schemaSnapshot(right.sessionId, right.database),
      ]);
      setDiff(computeDiff(l, r));
      setActiveView("tables");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const visible = useMemo(
    () => (diff ?? []).filter((t) => !onlyDiff || t.status !== "same"),
    [diff, onlyDiff]
  );

  const diffCount = useMemo(
    () => (diff ?? []).filter((t) => t.status !== "same").length,
    [diff]
  );

  /** タブごとの件数 */
  const counts = useMemo(() => {
    const d = diff ?? [];
    return {
      tables: d.filter(
        (t) =>
          t.status === "added" || t.status === "removed" || t.attrs.length > 0
      ).length,
      columns: d.reduce((sum, t) => sum + t.columns.length, 0),
      indexes: d.reduce((sum, t) => sum + t.indexes.length, 0),
    };
  }, [diff]);

  const columnTables = useMemo(
    () => (diff ?? []).filter((t) => t.columns.length > 0),
    [diff]
  );
  const indexTables = useMemo(
    () => (diff ?? []).filter((t) => t.indexes.length > 0),
    [diff]
  );

  const renderItemDiffs = (title: string, items: ItemDiff[]) =>
    items.length > 0 && (
      <>
        <div className="diff-subhead">{title}</div>
        {items.map((it) => (
          <div key={title + it.name}>
            <div className={`diff-row diff-item-row ${it.status}`}>
              <span className="diff-label mono">{it.name}</span>
              <span className={`diff-cell mono ${it.status === "added" ? "empty" : ""}`}>
                {it.status === "added" ? "—" : it.status === "removed" ? "あり" : ""}
              </span>
              <span className={`diff-cell mono ${it.status === "removed" ? "empty" : ""}`}>
                {it.status === "removed" ? "—" : it.status === "added" ? "あり" : ""}
              </span>
            </div>
            {it.fields.map((f) => (
              <div className="diff-row changed" key={it.name + f.label}>
                <span className="diff-label">
                  <span className="diff-field-owner mono">{it.name}</span> {f.label}
                </span>
                <span className="diff-cell mono left">
                  <DiffValue value={f.left} other={f.right} />
                </span>
                <span className="diff-cell mono right">
                  <DiffValue value={f.right} other={f.left} />
                </span>
              </div>
            ))}
          </div>
        ))}
      </>
    );

  return (
    <div
      className="diff-window"
      style={{ "--diff-label-w": `${labelWidth}px` } as React.CSSProperties}
    >
      <div className="diff-toolbar" data-tauri-drag-region>
        {sideSelector(left, setLeft, "左: 接続を選択")}
        <span className="diff-vs">⇄</span>
        {sideSelector(right, setRight, "右: 接続を選択")}
        <button
          className="btn-primary diff-compare"
          onClick={handleCompare}
          disabled={
            loading ||
            !left.sessionId ||
            !left.database ||
            !right.sessionId ||
            !right.database
          }
        >
          {loading ? (
            <>
              <span className="spinner light" /> 比較中...
            </>
          ) : (
            "比較"
          )}
        </button>
        <label className="switch diff-only">
          <input
            type="checkbox"
            checked={onlyDiff}
            onChange={(e) => setOnlyDiff(e.target.checked)}
          />
          <span className="track" aria-hidden />
          <span className="switch-label">差異のみ表示</span>
        </label>
      </div>

      {sessions.length === 0 && (
        <div className="content-placeholder dim-center">
          比較するにはメインウィンドウでDBに接続してください
        </div>
      )}

      {error && (
        <div className="result-banner ng diff-error">
          <span className="dot" aria-hidden />
          <strong>エラー</strong>
          <span className="result-detail">{error}</span>
        </div>
      )}

      {diff && (
        <div className="diff-body">
          <div className="diff-tabs-row">
            <div className="result-tabs diff-view-tabs">
              {(
                [
                  ["tables", "テーブル", counts.tables],
                  ["columns", "カラム", counts.columns],
                  ["indexes", "インデックス", counts.indexes],
                ] as const
              ).map(([view, label, count]) => (
                <button
                  key={view}
                  className={
                    "result-tab" + (activeView === view ? " active" : "")
                  }
                  onClick={() => setActiveView(view)}
                >
                  {label} ({count})
                </button>
              ))}
            </div>
            <span className="diff-summary mono">
              {diff.length}テーブル中 {diffCount}件に差異
            </span>
          </div>

          <div className="diff-head diff-row">
            <span className="diff-label">
              項目
              <span
                className="diff-label-resizer"
                onMouseDown={startLabelResize}
              />
            </span>
            <span className="diff-cell">左: {left.database}</span>
            <span className="diff-cell">右: {right.database}</span>
          </div>

          <div className="diff-list">
            {/* ---- テーブルタブ ---- */}
            {activeView === "tables" && (
              <>
                {visible.length === 0 && (
                  <div className="content-placeholder dim-center">
                    {diffCount === 0
                      ? "差異はありません 🎉"
                      : "表示対象がありません"}
                  </div>
                )}
                {visible.map((t) => (
                  <div className="diff-table" key={t.key}>
                    <div className={`diff-table-head ${t.status}`}>
                      <span className="mono diff-table-name">{t.key}</span>
                      <span className="diff-inline-counts">
                        {t.columns.length > 0 && (
                          <span>カラム差異 {t.columns.length}件</span>
                        )}
                        {t.indexes.length > 0 && (
                          <span>インデックス差異 {t.indexes.length}件</span>
                        )}
                      </span>
                      <span className={`diff-status ${t.status}`}>
                        {STATUS_LABEL[t.status]}
                      </span>
                    </div>
                    {t.status === "added" && (
                      <div className="diff-row added">
                        <span className="diff-label">テーブル</span>
                        <span className="diff-cell mono empty">—</span>
                        <span className="diff-cell mono">あり</span>
                      </div>
                    )}
                    {t.status === "removed" && (
                      <div className="diff-row removed">
                        <span className="diff-label">テーブル</span>
                        <span className="diff-cell mono">あり</span>
                        <span className="diff-cell mono empty">—</span>
                      </div>
                    )}
                    {t.attrs.map((f) => (
                      <div className="diff-row changed" key={f.label}>
                        <span className="diff-label">{f.label}</span>
                        <span className="diff-cell mono left">
                          <DiffValue value={f.left} other={f.right} />
                        </span>
                        <span className="diff-cell mono right">
                          <DiffValue value={f.right} other={f.left} />
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}

            {/* ---- カラムタブ ---- */}
            {activeView === "columns" && (
              <>
                {columnTables.length === 0 && (
                  <div className="content-placeholder dim-center">
                    カラムの差異はありません
                  </div>
                )}
                {columnTables.map((t) => (
                  <div className="diff-table" key={t.key}>
                    <div className="diff-table-head changed">
                      <span className="mono diff-table-name">{t.key}</span>
                      <span className="diff-status changed">
                        {t.columns.length}件
                      </span>
                    </div>
                    {renderItemDiffs("カラム", t.columns)}
                  </div>
                ))}
              </>
            )}

            {/* ---- インデックスタブ ---- */}
            {activeView === "indexes" && (
              <>
                {indexTables.length === 0 && (
                  <div className="content-placeholder dim-center">
                    インデックスの差異はありません
                  </div>
                )}
                {indexTables.map((t) => (
                  <div className="diff-table" key={t.key}>
                    <div className="diff-table-head changed">
                      <span className="mono diff-table-name">{t.key}</span>
                      <span className="diff-status changed">
                        {t.indexes.length}件
                      </span>
                    </div>
                    {renderItemDiffs("インデックス", t.indexes)}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
