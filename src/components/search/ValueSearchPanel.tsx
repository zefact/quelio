import { useState } from "react";
import { searchValues } from "../../api";
import { JobProgress } from "../JobProgress";
import {
  GridColumn,
  GridRow,
  ResizableGrid,
  RowMenuItem,
} from "../ResizableGrid";
import { newJobId } from "../kvBulk/jobId";
import type { DbType, ValueHit, ValueSearchResult } from "../../types";

/** 表示する列 (PostgreSQL以外ではスキーマ列を出さない) */
function columns(dbType: DbType): GridColumn[] {
  const cols: GridColumn[] = [];
  if (dbType === "postgresql") {
    cols.push({ id: "schema", label: "スキーマ", width: 130, minWidth: 70 });
  }
  cols.push(
    { id: "table", label: "テーブル", width: 200, minWidth: 100, wrap: true },
    { id: "column", label: "カラム", width: 180, minWidth: 90, wrap: true },
    { id: "value", label: "見つかった値", width: 420, minWidth: 140, wrap: true }
  );
  return cols;
}

interface Props {
  sessionId: string;
  dbType: DbType;
  /** 探す対象のデータベース */
  database: string | undefined;
  /** 見つけたテーブルを開く */
  onOpen: (hit: ValueHit) => void;
  /** 実行中かどうかを親へ伝える (閉じさせないため) */
  onBusyChange: (busy: boolean) => void;
}

/** 値の中から文字列を探す */
export function ValueSearchPanel({
  sessionId,
  dbType,
  database,
  onOpen,
  onBusyChange,
}: Props) {
  const [needle, setNeedle] = useState("");
  const [ignoreCase, setIgnoreCase] = useState(true);
  const [job, setJob] = useState<{ id: string; startedAt: number } | null>(
    null
  );
  const [found, setFound] = useState<ValueSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!needle.trim() || job) return;
    const started = { id: newJobId("valsearch"), startedAt: Date.now() };
    setJob(started);
    setError(null);
    setFound(null);
    onBusyChange(true);
    try {
      setFound(
        await searchValues(
          sessionId,
          database,
          { needle: needle.trim(), ignoreCase },
          started.id
        )
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setJob(null);
      onBusyChange(false);
    }
  };

  const hits = found?.hits ?? [];
  const rows: GridRow[] = hits.map((h, i) => {
    const cells: React.ReactNode[] = [];
    if (dbType === "postgresql") {
      cells.push(<span className="mono dim">{h.schema}</span>);
    }
    cells.push(
      <span className="mono">{h.table}</span>,
      h.approximate ? (
        <span
          className="faint"
          title="DBの照合順序で当たった行です (全角と半角を同じとみなす等)。どの列に入っているかまでは分かりません"
        >
          {h.column} (推定)
        </span>
      ) : (
        <span className="mono">{h.column}</span>
      ),
      <span className="mono">{h.value}</span>
    );
    return { key: `${i}\u0001${h.schema}.${h.table}.${h.column}`, cells };
  });

  const open = (rowKey: string) => {
    // 行キーの先頭に位置を入れてある (同じ列が複数行当たるため)
    const hit = hits[Number(rowKey.split("\u0001")[0])];
    if (hit) onOpen(hit);
  };

  const rowMenuItems = (rowKey: string): RowMenuItem[] => [
    { label: "このテーブルを開く", onSelect: () => open(rowKey) },
  ];

  return (
    <div className="kv-bulk-panel">
      <div className="db-admin-row">
        <input
          className="text-field mono db-admin-name"
          value={needle}
          spellCheck={false}
          disabled={!!job}
          placeholder="値の中から探す文字列"
          onChange={(e) => setNeedle(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") void run();
          }}
        />
        <button
          className="btn-primary"
          disabled={!needle.trim() || !!job}
          onClick={run}
        >
          検索
        </button>
      </div>

      <div className="kv-bulk-opts">
        <label className="switch">
          <input
            type="checkbox"
            checked={ignoreCase}
            disabled={!!job}
            onChange={(e) => setIgnoreCase(e.target.checked)}
          />
          <span className="track" aria-hidden />
          <span className="switch-label">大文字小文字を区別しない</span>
        </label>
      </div>

      {job && (
        <JobProgress
          jobId={job.id}
          startedAt={job.startedAt}
          verb="走査"
          unit="テーブル"
          onError={setError}
        />
      )}

      {error && (
        <div className="result-banner ng">
          <span className="dot" aria-hidden />
          <span className="result-detail">{error}</span>
        </div>
      )}

      {found && (
        <div className="result-banner">
          <span className="dot" aria-hidden />
          <span className="result-detail">
            {hits.length.toLocaleString()}件が一致 (
            {found.scanned.toLocaleString()}テーブルを確認)
            {found.truncated && " — 上限に達したため途中で止めました"}
            {found.cancelled && " — 中止しました"}
          </span>
        </div>
      )}

      {found && found.skipped.length > 0 && (
        <div className="result-banner warn">
          <span className="dot" aria-hidden />
          <span className="result-detail">
            読めなかったテーブルがあります: {found.skipped.join(" / ")}
          </span>
        </div>
      )}

      <div className="kv-bulk-hits">
        <ResizableGrid
          columns={columns(dbType)}
          rows={rows}
          selectable
          stableRowKeys
          rowMenuItems={rowMenuItems}
          onCellDoubleClick={open}
          emptyText={
            found ? "一致する値がありません" : "探す文字列を入れて検索します"
          }
        />
      </div>

      <p className="db-admin-hint">
        行をダブルクリックすると、そのテーブルを開きます。
        探すのは<strong>文字列型の列だけ</strong>です
        (数値・日付・バイナリの列は対象外)。
        テーブルごとに1回ずつ問い合わせ、当たった先頭20行までを出します。
        件数は数えないので、「どのテーブルのどの列に入っているか」を
        見るための機能です。大きなデータベースでは時間がかかります。
        「(推定)」の付いた行は、DBの照合順序で当たったものです
        (全角と半角を同じとみなす等)。
      </p>
    </div>
  );
}
