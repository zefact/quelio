import { useState } from "react";
import { searchObjects } from "../../api";
import {
  GridColumn,
  GridRow,
  ResizableGrid,
  RowMenuItem,
} from "../ResizableGrid";
import type { DbType, ObjectHit, ObjectSearchResult } from "../../types";

/** 表示する列 (PostgreSQL以外ではスキーマ列を出さない) */
function columns(dbType: DbType): GridColumn[] {
  // 幅は「画面に収まって横スクロールが出ない」ことを目安に決める
  const cols: GridColumn[] = [
    { id: "database", label: "データベース", width: 140, minWidth: 80 },
  ];
  if (dbType === "postgresql") {
    cols.push({ id: "schema", label: "スキーマ", width: 110, minWidth: 70 });
  }
  cols.push(
    { id: "table", label: "テーブル", width: 190, minWidth: 100, wrap: true },
    { id: "column", label: "カラム", width: 170, minWidth: 90, wrap: true },
    { id: "type", label: "型", width: 120, minWidth: 70 },
    { id: "comment", label: "コメント", width: 220, minWidth: 100, wrap: true }
  );
  return cols;
}

interface Props {
  sessionId: string;
  dbType: DbType;
  /** 探す対象のデータベース (PostgreSQLはこのDBの中だけ) */
  database: string | undefined;
  /** 見つけたテーブルを開く */
  onOpen: (hit: ObjectHit) => void;
}

/** テーブル名・カラム名・コメントから探す */
export function ObjectSearchPanel({
  sessionId,
  dbType,
  database,
  onOpen,
}: Props) {
  const [keyword, setKeyword] = useState("");
  const [found, setFound] = useState<ObjectSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const k = keyword.trim();
    if (!k || busy) return;
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      setFound(await searchObjects(sessionId, database, k));
    } catch (e) {
      setError(String(e));
    } finally {
      /*
       * 名前の検索は中止する手立てが無いので、実行中も画面は閉じられるままにする
       * (閉じられないうえに止められない、という行き止まりを作らない)
       */
      setBusy(false);
    }
  };

  const list = found?.hits ?? [];
  const rows: GridRow[] = list.map((h, i) => {
    const cells: React.ReactNode[] = [
      <span className="mono">{h.database}</span>,
    ];
    if (dbType === "postgresql") {
      cells.push(<span className="mono dim">{h.schema}</span>);
    }
    cells.push(
      <span className="mono">{h.table}</span>,
      <span className="mono">{h.column}</span>,
      <span className="mono faint">{h.dataType}</span>,
      <span className="dim">{h.comment}</span>
    );
    return {
      key: `${i}\u0001${h.database}.${h.schema}.${h.table}.${h.column}`,
      cells,
    };
  });

  const open = (rowKey: string) => {
    // 行キーの先頭に位置を入れてある (同じテーブルの別の列が並ぶため)
    const hit = list[Number(rowKey.split("\u0001")[0])];
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
          value={keyword}
          spellCheck={false}
          disabled={busy}
          placeholder="テーブル名 / カラム名 / コメントの一部"
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") void run();
          }}
        />
        <button
          className="btn-primary"
          disabled={busy || !keyword.trim()}
          onClick={run}
        >
          {busy ? "検索中..." : "検索"}
        </button>
      </div>

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
            {list.length === 0
              ? "一致するものはありません"
              : `${list.length.toLocaleString()}件が一致`}
            {found.truncated && " (上限に達したため打ち切りました)"}
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
            found
              ? "一致するテーブル・カラムがありません"
              : "探す文字列を入れて検索します"
          }
        />
      </div>

      <p className="db-admin-hint">
        行をダブルクリックすると、そのテーブルを開きます。
        {dbType === "sqlite"
          ? "このファイルの中が対象です。"
          : `対象は選んでいるデータベース (${database ?? ""}) の中だけです。`}
        {dbType === "postgresql" && "全スキーマが対象です。"}
      </p>
    </div>
  );
}
