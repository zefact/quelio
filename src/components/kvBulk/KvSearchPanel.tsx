import { useState } from "react";
import { kvSearch } from "../../api";
import { JobProgress } from "../JobProgress";
import {
  GridColumn,
  GridRow,
  ResizableGrid,
  RowMenuItem,
} from "../ResizableGrid";
import { newJobId } from "./jobId";
import type { KvSearchResult } from "../../types";

const COLS: GridColumn[] = [
  { id: "key", label: "キー", width: 260, minWidth: 120, wrap: true },
  { id: "type", label: "型", width: 80, minWidth: 50 },
  { id: "field", label: "場所", width: 120, minWidth: 60 },
  { id: "preview", label: "当たった値", width: 380, minWidth: 140, wrap: true },
];

interface Props {
  sessionId: string;
  database: string;
  /** キーブラウザで使っているパターン (初期値) */
  initialPattern: string;
  /** 当たったキーを選んで詳細を開く */
  onPickKey: (key: string) => void;
  /** 実行中かどうかを親へ伝える (閉じさせないため) */
  onBusyChange: (busy: boolean) => void;
}

/** 値の中から文字列を探す */
export function KvSearchPanel({
  sessionId,
  database,
  initialPattern,
  onPickKey,
  onBusyChange,
}: Props) {
  const [pattern, setPattern] = useState(initialPattern);
  const [needle, setNeedle] = useState("");
  const [ignoreCase, setIgnoreCase] = useState(true);
  const [includeKeys, setIncludeKeys] = useState(true);
  const [job, setJob] = useState<{ id: string; startedAt: number } | null>(
    null
  );
  const [found, setFound] = useState<KvSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!needle.trim() || job) return;
    const started = { id: newJobId("kvfind"), startedAt: Date.now() };
    setJob(started);
    setError(null);
    setFound(null);
    onBusyChange(true);
    try {
      setFound(
        await kvSearch(
          sessionId,
          database,
          pattern,
          { needle, ignoreCase, includeKeys },
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
  /* 同じキーの別の場所が当たることもあるので、行のキーは位置で作る */
  const rows: GridRow[] = hits.map((h, i) => ({
    key: `${i}\u0001${h.key}\u0001${h.field}`,
    cells: [
      <span className="mono">{h.key}</span>,
      <span className="mono dim">{h.type}</span>,
      <span className="mono faint">{h.field}</span>,
      <span className="mono">{h.preview}</span>,
    ],
  }));

  const open = (rowKey: string) => {
    // 行キーの先頭に位置を入れてある (同じキーの別の場所が並ぶため)
    const hit = hits[Number(rowKey.split("\u0001")[0])];
    if (hit) onPickKey(hit.key);
  };

  const rowMenuItems = (rowKey: string): RowMenuItem[] => [
    { label: "このキーを開く", onSelect: () => open(rowKey) },
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
        <input
          className="text-field mono db-admin-opt"
          value={pattern}
          spellCheck={false}
          disabled={!!job}
          placeholder="キーのパターン (例: user:*)"
          title="探す範囲を絞ります。空欄なら全キーが対象です"
          onChange={(e) => setPattern(e.target.value)}
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
        <label className="switch">
          <input
            type="checkbox"
            checked={includeKeys}
            disabled={!!job}
            onChange={(e) => setIncludeKeys(e.target.checked)}
          />
          <span className="track" aria-hidden />
          <span className="switch-label">キー名も探す</span>
        </label>
      </div>

      {job && (
        <JobProgress
          jobId={job.id}
          startedAt={job.startedAt}
          verb="走査"
          unit="件"
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
            {found.scanned.toLocaleString()}キーを確認)
            {found.truncated && " — 上限に達したため途中で止めました"}
            {found.cancelled && " — 中止しました"}
          </span>
        </div>
      )}

      <div className="kv-bulk-hits">
        <ResizableGrid
          columns={COLS}
          rows={rows}
          selectable
          stableRowKeys
          rowMenuItems={rowMenuItems}
          onCellDoubleClick={open}
          emptyText={
            found ? "一致するキーがありません" : "探す文字列を入れて検索します"
          }
        />
      </div>

      <p className="db-admin-hint">
        行をダブルクリックすると、そのキーを開きます。
        値は1キーあたり先頭のいくつかだけを見ます (文字列は先頭64KB、
        その他は先頭1000要素まで)。stream型は対象外です。
      </p>
    </div>
  );
}
