import { useEffect, useMemo, useRef, useState } from "react";
import { clearQueryLog, getQueryLog } from "../api";
import type { QueryLogEntry } from "../types";

const POLL_INTERVAL_MS = 800;

interface Col {
  id: "time" | "connection" | "database" | "query";
  label: string;
  width: number;
  minWidth: number;
}

const COLS: Col[] = [
  { id: "time", label: "時刻", width: 92, minWidth: 70 },
  { id: "connection", label: "接続", width: 150, minWidth: 80 },
  { id: "database", label: "データベース", width: 150, minWidth: 80 },
  { id: "query", label: "クエリ", width: 560, minWidth: 200 },
];

/** コンソールウィンドウ: DBに発行した全SQLを表示 */
export function ConsoleWindow() {
  const [entries, setEntries] = useState<QueryLogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [widths, setWidths] = useState<Record<string, number>>(() =>
    Object.fromEntries(COLS.map((c) => [c.id, c.width]))
  );
  const lastSeq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // 差分ポーリングで取得
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const fresh = await getQueryLog(lastSeq.current);
        if (!stopped && fresh.length > 0) {
          lastSeq.current = fresh[fresh.length - 1].seq;
          setEntries((es) => [...es, ...fresh].slice(-2000));
        }
      } catch {
        /* メインプロセス未接続時は無視 */
      }
    };
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  // 末尾追従 (ユーザーが上にスクロールしたら追従を止める)
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const startResize = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widths[id];
    const min = COLS.find((c) => c.id === id)?.minWidth ?? 50;
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    const move = (ev: MouseEvent) => {
      setWidths((w) => ({
        ...w,
        [id]: Math.max(min, startW + ev.clientX - startX),
      }));
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.body.style.cursor = prevCursor;
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  const handleClear = async () => {
    try {
      await clearQueryLog();
    } catch {
      /* 無視 */
    }
    setEntries([]);
  };

  const filtered = useMemo(() => {
    if (!filter) return entries;
    const f = filter.toLowerCase();
    return entries.filter(
      (e) =>
        e.query.toLowerCase().includes(f) ||
        e.connection.toLowerCase().includes(f) ||
        e.database.toLowerCase().includes(f)
    );
  }, [entries, filter]);

  const total = COLS.reduce((sum, c) => sum + widths[c.id], 0);

  return (
    <div className="console">
      <div className="console-toolbar" data-tauri-drag-region>
        <input
          className="filter-input mono console-filter"
          placeholder="フィルタ (SQL / 接続名 / DB名)..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="console-count">{filtered.length} 件</span>
        <button className="btn-ghost" onClick={handleClear}>
          クリア
        </button>
      </div>

      <div className="console-list" ref={listRef} onScroll={onScroll}>
        <table
          className="grid resizable console-grid"
          style={{ width: total, tableLayout: "fixed" }}
        >
          <colgroup>
            {COLS.map((c) => (
              <col key={c.id} style={{ width: widths[c.id] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.id}>
                  <span className="th-label">{c.label}</span>
                  <span
                    className="col-resizer"
                    onMouseDown={(e) => startResize(c.id, e)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr
                key={e.seq}
                className={e.query.startsWith("--") ? "meta" : ""}
              >
                <td className="mono faint">{e.time}</td>
                <td className="dim wrap">{e.connection}</td>
                <td className="mono console-db wrap">{e.database}</td>
                <td className="mono console-query wrap">{e.query}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={COLS.length} className="console-empty">
                  {entries.length === 0
                    ? "まだクエリが実行されていません"
                    : "フィルタに一致するクエリがありません"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
