import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { clearQueryLog, getQueryLog } from "../api";
import type { QueryLogEntry } from "../types";
import { usePolling } from "../hooks/usePolling";
import { GridColumn, GridRow, ResizableGrid } from "./ResizableGrid";
import { ConsoleExport } from "./ConsoleExport";

/** SQLを記録したときにバックエンドが流すイベント名 (query_log.rs と対応) */
const QUERY_LOG_EVENT = "query-log";

/**
 * 取りこぼしを拾い直す間隔。
 * 通常はイベントで届くので、これは念のための照合にすぎない
 */
const RECONCILE_INTERVAL_MS = 15000;

/** 画面に保持する最大件数 (古いものから捨てる) */
const MAX_ENTRIES = 2000;

/** 一度に描画する件数 (末尾から。上へスクロールすると増える) */
const RENDER_LIMIT = 300;

/** 続きを描画するときに一度に足す件数 */
const RENDER_STEP = 300;

const COLS: GridColumn[] = [
  { id: "time", label: "時刻", width: 92, minWidth: 70, sortable: false },
  {
    id: "connection",
    label: "接続",
    width: 150,
    minWidth: 80,
    wrap: true,
    sortable: false,
  },
  {
    id: "database",
    label: "データベース",
    width: 150,
    minWidth: 80,
    wrap: true,
    sortable: false,
  },
  {
    id: "query",
    label: "クエリ",
    width: 560,
    minWidth: 200,
    wrap: true,
    sortable: false,
  },
];

/** コンソールウィンドウ: DBに発行した全SQLを表示 */
export function ConsoleWindow() {
  const [entries, setEntries] = useState<QueryLogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  /** 次に取りに行く位置 (これより後を要求する) */
  const lastSeq = useRef(0);
  /** クリアした回数。クリア前に始まった取得の結果を捨てるために使う */
  const generation = useRef(0);

  /**
   * 受け取った行を取り込む。
   *
   * イベントと取得の両方から同じ行が来ることがあるので、
   * 「今持っているseq」と突き合わせて重複を落とす
   * (渡された配列の中に同じ行が2つある場合も落とす)
   */
  const push = useRef<(list: QueryLogEntry[], gen: number) => void>(() => {});
  push.current = (list, gen) => {
    // 取得中にクリアされていたら、消したはずの行を戻さない
    if (gen !== generation.current) return;
    if (list.length === 0) return;
    const maxSeq = list.reduce((m, e) => Math.max(m, e.seq), 0);
    if (maxSeq > lastSeq.current) lastSeq.current = maxSeq;
    setEntries((es) => {
      // 末尾に足すだけなら (ほとんどがこれ) 突き合わせは要らない
      const tail = es.length === 0 ? 0 : es[es.length - 1].seq;
      if (list.every((e, i) => e.seq > (i === 0 ? tail : list[i - 1].seq))) {
        return [...es, ...list].slice(-MAX_ENTRIES);
      }
      const have = new Set(es.map((e) => e.seq));
      const add: QueryLogEntry[] = [];
      for (const e of list) {
        if (have.has(e.seq)) continue;
        have.add(e.seq);
        add.push(e);
      }
      if (add.length === 0) return es;
      return [...es, ...add].sort((x, y) => x.seq - y.seq).slice(-MAX_ENTRIES);
    });
  };

  /*
   * 記録のたびにバックエンドからイベントが飛んでくるので、それを受け取る。
   *
   * 初回の取得より先に受信を始めて、その間に届いたぶんは溜めておく
   * (先に取得すると、取得〜受信開始の隙間に出たSQLを取りこぼす)
   */
  useEffect(() => {
    let alive = true;
    let ready = false;
    const buffered: QueryLogEntry[] = [];
    const un = listen<QueryLogEntry>(QUERY_LOG_EVENT, (ev) => {
      if (!alive) return;
      if (!ready) {
        buffered.push(ev.payload);
        return;
      }
      push.current([ev.payload], generation.current);
    });
    const gen = generation.current;
    // 受信の登録が終わってから取りに行く (登録前のぶんは取得側に入っている)
    un.then(() => getQueryLog(0))
      .catch(() => [] as QueryLogEntry[])
      .then((first) => {
        if (!alive) return;
        ready = true;
        push.current([...first, ...buffered], gen);
        buffered.length = 0;
      });
    return () => {
      alive = false;
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  /*
   * 念のための照合。
   * イベントが届かなかった場合でも、記録が目的の画面なので取り返せるようにする
   */
  usePolling(() => {
    const gen = generation.current;
    getQueryLog(lastSeq.current)
      .then((fresh) => push.current(fresh, gen))
      .catch(() => {
        /* メインプロセス未接続時は無視 */
      });
  }, RECONCILE_INTERVAL_MS);

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
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickToBottom.current = atBottom;
    if (atBottom) {
      // 末尾まで戻ったら追従に切り替える
      if (pinnedSeq !== null) setPinnedSeq(null);
      return;
    }
    // 上を読んでいる間は描画の先頭を固定する
    if (pinnedSeq === null && visible.length > 0) {
      setPinnedSeq(visible[0].seq);
    }
    // 上端に近づいたら古いぶんを継ぎ足す
    if (el.scrollTop < 200 && hidden > 0 && visible.length > 0) {
      const tr = el.querySelector<HTMLElement>(
        `[data-row-key="${visible[0].seq}"]`
      );
      growAnchor.current = {
        seq: visible[0].seq,
        top: tr ? tr.offsetTop - el.scrollTop : 0,
      };
      setPinnedSeq(filtered[Math.max(0, startIdx - RENDER_STEP)].seq);
    }
  };

  /** クリアに失敗したときの表示 (消えていないのに消えたように見せない) */
  const [clearError, setClearError] = useState<string | null>(null);
  const handleClear = async () => {
    setClearError(null);
    try {
      await clearQueryLog();
    } catch (e) {
      setClearError(`クリアできませんでした: ${e}`);
      return;
    }
    // ここまでに始まっていた取得の結果は反映させない
    // (消したはずの行が後から戻らないように)
    generation.current += 1;
    setEntries([]);
    /*
     * 取得位置を先頭に戻して取り直す。
     *
     * クリアを頼んでから返事が返るまでの間に記録された行は、
     * バックエンドには残っているのに画面から消えてしまう。
     * ここで取り直せば拾い直せる (重複はseqで落ちる)
     */
    lastSeq.current = 0;
    // 空になったので、描画範囲の固定も末尾追従に戻す
    setPinnedSeq(null);
    stickToBottom.current = true;
    growAnchor.current = null;
    const gen = generation.current;
    getQueryLog(0)
      .then((fresh) => push.current(fresh, gen))
      .catch(() => {});
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

  /*
   * 描画するのは一部だけ。2000件×4列を毎回DOMへ出すと、
   * 開きっぱなしのこの画面が重くなる。
   *
   * 末尾追従中は「末尾からRENDER_LIMIT件」。
   * ユーザーが上を読んでいる間は先頭のseqを固定しておく
   * (新着が来るたびに描画範囲がずれると、読んでいる位置が飛ぶため)
   */
  const [pinnedSeq, setPinnedSeq] = useState<number | null>(null);

  // フィルタが変わったら末尾に戻す (描画してから縮めるとちらつくのでレンダー中に直す)
  const [lastFilter, setLastFilter] = useState(filter);
  if (lastFilter !== filter) {
    setLastFilter(filter);
    setPinnedSeq(null);
    stickToBottom.current = true;
  }

  const tailStart = Math.max(0, filtered.length - RENDER_LIMIT);
  // 固定した行が (古くなって) 消えていたら末尾側に戻す
  const pinnedIdx =
    pinnedSeq === null ? -1 : filtered.findIndex((e) => e.seq >= pinnedSeq);
  const startIdx = pinnedIdx === -1 ? tailStart : pinnedIdx;
  const visible = useMemo(
    () => filtered.slice(startIdx),
    [filtered, startIdx]
  );
  const hidden = startIdx;

  /** 上に足したぶんだけ位置がずれないよう、基準にする行 */
  const growAnchor = useRef<{ seq: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = listRef.current;
    const anchor = growAnchor.current;
    if (!el || !anchor) return;
    growAnchor.current = null;
    const tr = el.querySelector<HTMLElement>(`[data-row-key="${anchor.seq}"]`);
    if (tr) el.scrollTop = tr.offsetTop - anchor.top;
  }, [startIdx]);

  const rows: GridRow[] = useMemo(
    () =>
      visible.map((e) => ({
        key: String(e.seq),
        className: e.query.startsWith("--") ? "meta" : undefined,
        cells: [
          <span className="mono faint">{e.time}</span>,
          <span className="dim">{e.connection}</span>,
          <span className="mono console-db">{e.database}</span>,
          <span className="mono console-query">{e.query}</span>,
        ],
      })),
    [visible]
  );

  return (
    <div className="console">
      <div className="console-toolbar" data-tauri-drag-region>
        <input
          className="filter-input mono console-filter"
          placeholder="フィルタ (SQL / 接続名 / DB名)..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="console-count">
          {filtered.length} 件
          {hidden > 0 && (
            <span className="faint">
              {" "}
              (新しい{visible.length}件を表示 —
              上へスクロールすると続きを表示します)
            </span>
          )}
        </span>
        <ConsoleExport filter={filter} hasEntries={filtered.length > 0} />
        <button className="btn-ghost" onClick={handleClear}>
          クリア
        </button>
        {clearError && <span className="console-error">{clearError}</span>}
      </div>

      <ResizableGrid
        columns={COLS}
        rows={rows}
        selectable
        stableRowKeys
        wrapClass="console-list"
        wrapRefOut={listRef}
        onScroll={onScroll}
        emptyText={
          entries.length === 0
            ? "まだクエリが実行されていません"
            : "フィルタに一致するクエリがありません"
        }
      />
    </div>
  );
}
