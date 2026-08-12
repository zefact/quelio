import { useEffect, useMemo, useRef, useState } from "react";
import { format } from "sql-formatter";
import { getAppSettings } from "../api";
import { captureResults } from "../capture";
import { useResizableHeight } from "../hooks/useResizableHeight";
import type { DbType, StatementResult } from "../types";
import { QUERY_PAGE_SIZE } from "../types";
import { isPlanResult, planLines, PlanView } from "./PlanView";
import { GridColumn, ResizableGrid, SortState } from "./ResizableGrid";
import { SqlEditor, SqlEditorHandle } from "./SqlEditor";

type RunMode = "all" | "selection";

/**
 * 行末のカンマを次行の先頭に移す (カンマ先頭スタイル)。
 * 例: "  company_cd,"  →  "  company_cd" / "  , company_kbn"
 */
function toLeadingCommas(sql: string): string {
  const lines = sql.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd().endsWith(",")) {
      // カンマを移す先 = 次の非空行
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length) {
        lines[i] = lines[i].trimEnd().slice(0, -1);
        lines[j] = lines[j].replace(/^(\s*)/, "$1, ");
      }
    }
  }
  return lines.join("\n");
}

/** セル値の比較 (数値として解釈できれば数値比較、NULLは常に末尾) */
function compareCells(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (a.trim() !== "" && b.trim() !== "") {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  }
  return a.localeCompare(b, "ja");
}

/** MySQLの表形式EXPLAINの各カラムの意味 (ヘッダのツールチップに出す) */
const EXPLAIN_COL_DESC: Record<string, string> = {
  id: "SELECTの識別子。同じ番号は同じレベルで実行される",
  select_type:
    "SELECTの種類。SIMPLE=単純なSELECT / PRIMARY=外側 / SUBQUERY=サブクエリ / DERIVED=FROM句の派生表 / UNION など",
  table: "アクセスするテーブル。<derivedN>はFROM句の派生表",
  partitions: "アクセスするパーティション (パーティション未使用ならNULL)",
  type:
    "アクセス方式。良い順に const > eq_ref > ref > range > index > ALL。ALLは全件走査なので改善余地あり",
  possible_keys: "使える可能性があると判断されたインデックスの候補",
  key: "実際に使われたインデックス。NULLならインデックス未使用",
  key_len:
    "使われたインデックスのバイト長。複合インデックスのうちどこまで使えたかがわかる",
  ref: "インデックスと比較されている列や定数",
  rows: "調べる必要があると予測された行数。少ないほど良い",
  filtered: "WHERE条件で絞り込んだ後に残ると予測される行の割合(%)",
  extra:
    "追加情報。Using filesort / Using temporary が出ていたら改善余地のサイン。Using index はカバリングインデックスで良好",
};

/** 結果タブのラベル: "1: SELECT" のように文の種類を添える */
function statementLabel(sql: string, index: number): string {
  const head = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? "SQL";
  return `${index + 1}: ${head}`;
}

interface Props {
  dbType: DbType;
  sql: string;
  results: StatementResult[] | null;
  error: string | null;
  running: boolean;
  /** 実行開始時刻 (epoch ms)。タブ切替をまたいで経過時間を継続するため */
  runStartedAt: number | null;
  /** 直前の実行がEXPLAIN系だったか (ヘッダの意味ツールチップ用) */
  explainKind: "explain" | "analyze" | null;
  onChangeSql: (sql: string) => void;
  /** offset行目からの実行。sqlOverride指定時は選択実行、transactionでBEGIN〜COMMIT/ROLLBACKに包む */
  onRun: (
    offset: number,
    sqlOverride?: string,
    transaction?: boolean,
    explain?: "explain" | "analyze"
  ) => void;
  /** 実行中SQLのキャンセル */
  onCancel: () => void;
  /** 結果タブ単位のページ送り (その文だけを再実行) */
  onPage: (index: number, offset: number) => void;
  /** サーバーサイドソートの変更 (ページング可能な結果のみ) */
  onServerSort: (
    index: number,
    orderBy: string | null,
    orderDir: "asc" | "desc"
  ) => void;
}

/** SQLエディタ(行番号付き) + 実行結果ペイン(文ごとのタブ) */
export function QueryPanel({
  dbType,
  sql,
  results,
  error,
  running,
  runStartedAt,
  explainKind,
  onChangeSql,
  onRun,
  onCancel,
  onPage,
  onServerSort,
}: Props) {
  const [editorHeight, startResize] = useResizableHeight(220, 72, 4000);
  const [sort, setSort] = useState<SortState | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [hasSelection, setHasSelection] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);
  const [runMode, setRunMode] = useState<RunMode>("all");
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [explainMode, setExplainMode] = useState<"explain" | "analyze">(
    "explain"
  );
  const [explainMenuOpen, setExplainMenuOpen] = useState(false);
  const [captureOn, setCaptureOn] = useState(false);
  const [txnOn, setTxnOn] = useState(false);
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  /** 直前の実行でキャプチャを要求されたか */
  const captureReq = useRef(false);
  const editorRef = useRef<SqlEditorHandle>(null);
  /** 実行中の経過時間 (ms) */
  const [elapsedMs, setElapsedMs] = useState(0);
  /** 行番号列を表示するか (設定。実行のたびに読み直す) */
  const [showRowNums, setShowRowNums] = useState(true);

  useEffect(() => {
    getAppSettings()
      .then((s) => setShowRowNums(s.showRowNumbers))
      .catch(() => {});
  }, [running]);

  // 実行中は経過時間を100msごとに更新する
  // (開始時刻は親のタブ状態が保持しているため、タブ切替で再マウントされてもリセットされない)
  useEffect(() => {
    if (!running) return;
    const start = runStartedAt ?? Date.now();
    setElapsedMs(Date.now() - start);
    const timer = window.setInterval(
      () => setElapsedMs(Date.now() - start),
      100
    );
    return () => window.clearInterval(timer);
  }, [running, runStartedAt]);

  // 新しい結果が来たら: ソート解除。文の構成が変わった場合のみ最後のタブへ
  // (ページ送りによる差し替えでは選択中のタブを維持する)
  const prevSig = useRef("");
  useEffect(() => {
    setSort(null);
    const sig = results?.map((s) => s.sql).join("␟") ?? "";
    if (sig !== prevSig.current) {
      prevSig.current = sig;
      setActiveIdx(results ? Math.max(0, results.length - 1) : 0);
    }
  }, [results]);

  useEffect(() => {
    setSort(null);
  }, [activeIdx]);

  /** 現在の選択テキストを取得 (なければnull) */
  const selectedText = (): string | null =>
    editorRef.current?.getSelectedText() ?? null;

  /** 現在のモードで実行 (キャプチャ要求も記録) */
  const run = () => {
    if (running) return;
    if (runMode === "selection") {
      const text = selectedText();
      if (!text?.trim()) return;
      captureReq.current = captureOn;
      setCaptureMsg(null);
      onRun(0, text, txnOn);
    } else {
      if (!sql.trim()) return;
      captureReq.current = captureOn;
      setCaptureMsg(null);
      onRun(0, undefined, txnOn);
    }
  };

  // 実行完了後にキャプチャを保存する
  useEffect(() => {
    if (running || !captureReq.current) return;
    captureReq.current = false;
    if (!results?.length) return;
    setCaptureMsg("キャプチャ保存中...");
    captureResults(results)
      .then((paths) =>
        setCaptureMsg(`キャプチャ保存: ${paths.length}件 → Downloads`)
      )
      .catch((e) => setCaptureMsg(`キャプチャ失敗: ${e}`));
  }, [running, results]);

  // 各メニュー(実行モード / EXPLAIN / エディタ右クリック)は画面クリックで閉じる
  useEffect(() => {
    if (!runMenuOpen && !explainMenuOpen && !ctxMenu) return;
    const close = () => {
      setRunMenuOpen(false);
      setExplainMenuOpen(false);
      setCtxMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [runMenuOpen, explainMenuOpen, ctxMenu]);

  const handleFormat = () => {
    setFormatError(null);
    try {
      // sql-formatterのMySQL方言はREPLACE()関数を
      // REPLACE INTO文と誤認してパースエラーになるため一時退避する
      const escaped = sql.replace(/\breplace\s*\(/gi, "QUELIO_REPLACE_FN(");
      let formatted = format(escaped, {
        language: dbType === "mysql" ? "mysql" : "postgresql",
        keywordCase: "upper",
        tabWidth: 2,
      });
      formatted = formatted.replace(/QUELIO_REPLACE_FN\s*\(/g, "REPLACE(");
      onChangeSql(toLeadingCommas(formatted));
    } catch (e) {
      // 構文が不完全で整形できない場合はエラーの要点を表示する
      const msg = String(e).split("\n")[0].replace(/^Error:\s*/, "");
      setFormatError(`整形できません: ${msg}`);
    }
  };

  /** EXPLAIN / EXPLAIN ANALYZE を実行 (選択があれば選択部分) */
  const runExplain = (mode: "explain" | "analyze") => {
    if (running || !sql.trim()) return;
    captureReq.current = captureOn;
    setCaptureMsg(null);
    const text = selectedText();
    onRun(0, text?.trim() ? text : undefined, false, mode);
  };

  /** ⌘/Ctrl+Enter: 選択があれば選択実行、なければ全体実行 */
  const runViaShortcut = () => {
    if (running || !sql.trim()) return;
    captureReq.current = captureOn;
    setCaptureMsg(null);
    const text = selectedText();
    if (text?.trim()) {
      onRun(0, text, txnOn);
    } else {
      onRun(0, undefined, txnOn);
    }
  };

  const active = results?.[activeIdx] ?? null;
  const result = active?.result ?? null;

  const gridColumns: GridColumn[] = useMemo(() => {
    const cols: GridColumn[] = (result?.columns ?? []).map((name, i) => ({
      id: `c${i}`,
      label: name,
      width: Math.min(260, Math.max(90, name.length * 10 + 40)),
      minWidth: 60,
      // EXPLAIN結果ならカラムの意味をヘッダのツールチップに出す
      description: explainKind
        ? EXPLAIN_COL_DESC[name.toLowerCase()]
        : undefined,
    }));
    if (showRowNums && cols.length > 0) {
      // 表示中の最大行番号に合わせて幅を決める
      const maxNum = (result?.offset ?? 0) + (result?.rows.length ?? 0);
      const width = Math.max(48, String(maxNum).length * 9 + 26);
      cols.unshift({
        id: "__row",
        label: "#",
        width,
        minWidth: 40,
        align: "right",
      });
    }
    return cols;
  }, [result, showRowNums, explainKind]);

  /**
   * ヘッダクリック: 昇順 → 降順 → なし の順に切り替え。
   * ページング可能な結果はサーバーサイドソート(その文を再実行)、
   * それ以外は表示中の行のクライアントソート。
   */
  const toggleSort = (id: string) => {
    if (id === "__row") return;
    if (result?.pageable) {
      const colName = result.columns[Number(id.slice(1))];
      if (!colName || running) return;
      if (result.orderBy !== colName) {
        onServerSort(activeIdx, colName, "asc");
      } else if (result.orderDir !== "desc") {
        onServerSort(activeIdx, colName, "desc");
      } else {
        onServerSort(activeIdx, null, "asc");
      }
      return;
    }
    setSort((cur) => {
      if (cur?.id !== id) return { id, dir: "asc" };
      if (cur.dir === "asc") return { id, dir: "desc" };
      return null;
    });
  };

  /** グリッドに表示するソート状態 (サーバーソート優先) */
  const gridSort: SortState | null = useMemo(() => {
    if (result?.pageable) {
      if (!result.orderBy) return null;
      const idx = result.columns.indexOf(result.orderBy);
      if (idx < 0) return null;
      return { id: `c${idx}`, dir: result.orderDir === "desc" ? "desc" : "asc" };
    }
    return sort;
  }, [result, sort]);

  /** ソート適用済みの行 (サーバーソート時はそのまま表示) */
  const sortedRows = useMemo(() => {
    const rows = (result?.rows ?? []).map((cells, index) => ({ cells, index }));
    if (result?.pageable || !sort) return rows;
    const col = Number(sort.id.slice(1));
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort(
      (a, b) => sign * compareCells(a.cells[col], b.cells[col])
    );
  }, [result, sort]);

  return (
    <div className="query-panel">
      {/* エディタ */}
      <div className="sql-editor" style={{ height: editorHeight }}>
        <SqlEditor
          ref={editorRef}
          value={sql}
          dbType={dbType}
          placeholder="SELECT * FROM ...  (複数のSQLは ; で区切って記述できます)"
          onChange={onChangeSql}
          onRun={runViaShortcut}
          onSelectionChange={setHasSelection}
          onContextMenu={(x, y) => setCtxMenu({ x, y })}
        />
      </div>

      {/* エディタの右クリックメニュー */}
      {ctxMenu && (
        <div
          className="context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="context-item"
            disabled={!sql.trim()}
            onClick={() => {
              setCtxMenu(null);
              handleFormat();
            }}
          >
            SQLを整形 (カンマ先頭)
          </button>
        </div>
      )}

      {/* アクション */}
      <div className="query-actions">
        <div className="run-split">
          <button
            className="btn-primary run-main"
            onClick={run}
            disabled={
              running ||
              (runMode === "all" ? !sql.trim() : !hasSelection)
            }
            title={
              runMode === "selection"
                ? "選択したテキストのみ実行"
                : "エディタ全体を実行"
            }
          >
            {running ? (
              <>
                <span className="spinner light" /> 実行中...
              </>
            ) : runMode === "all" ? (
              "実行"
            ) : (
              "選択実行"
            )}
          </button>
          <button
            className="btn-primary run-caret"
            onClick={() => setRunMenuOpen((o) => !o)}
            onMouseDown={(e) => e.stopPropagation()}
            disabled={running}
            title="実行モードを切り替え"
          >
            ▾
          </button>
          {runMenuOpen && (
            <div
              className="context-menu run-menu"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {(
                [
                  ["all", "実行 (全体)"],
                  ["selection", "選択実行 (選択部分のみ)"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  className={
                    "context-item" + (runMode === mode ? " checked" : "")
                  }
                  onClick={() => {
                    setRunMode(mode);
                    setRunMenuOpen(false);
                  }}
                >
                  {runMode === mode ? "✓ " : ""}
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="run-split explain-split">
          <button
            className="btn-secondary explain-btn run-main has-tooltip tooltip-left"
            data-tooltip={
              explainMode === "explain"
                ? "実行計画を表示 (EXPLAIN)"
                : "実際に実行して計画と実測時間を表示 (EXPLAIN ANALYZE)"
            }
            disabled={running || !sql.trim()}
            onClick={() => runExplain(explainMode)}
          >
            {explainMode === "explain" ? "EXPLAIN" : "ANALYZE"}
          </button>
          <button
            className="btn-secondary explain-btn run-caret"
            onClick={() => setExplainMenuOpen((o) => !o)}
            onMouseDown={(e) => e.stopPropagation()}
            disabled={running}
            title="EXPLAINの種類を切り替え"
          >
            ▾
          </button>
          {explainMenuOpen && (
            <div
              className="context-menu run-menu"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {(
                [
                  ["explain", "EXPLAIN (実行計画のみ表示)"],
                  ["analyze", "EXPLAIN ANALYZE (実際に実行して実測)"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  className={
                    "context-item" + (explainMode === mode ? " checked" : "")
                  }
                  onClick={() => {
                    setExplainMode(mode);
                    setExplainMenuOpen(false);
                  }}
                >
                  {explainMode === mode ? "✓ " : ""}
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        {running && (
          <button
            className="btn-secondary cancel-query-btn"
            onClick={onCancel}
            title="実行中のSQLをキャンセル"
          >
            キャンセル
          </button>
        )}
        <label
          className="switch capture-switch has-tooltip tooltip-left"
          data-tooltip="実行をBEGIN〜COMMITで包み、途中でエラーになったら自動ROLLBACKで全て取り消す"
        >
          <input
            type="checkbox"
            checked={txnOn}
            onChange={(e) => setTxnOn(e.target.checked)}
          />
          <span className="track" aria-hidden />
          <span className="switch-label">トランザクション</span>
        </label>
        <label
          className="switch capture-switch has-tooltip tooltip-left"
          data-tooltip="実行時にSQLと全結果タブをPNGでDownloadsに保存"
        >
          <input
            type="checkbox"
            checked={captureOn}
            onChange={(e) => setCaptureOn(e.target.checked)}
          />
          <span className="track" aria-hidden />
          <span className="switch-label">キャプチャ</span>
        </label>
        {formatError ? (
          <span className="format-error" title={formatError}>
            {formatError}
          </span>
        ) : captureMsg ? (
          <span className="capture-msg mono" title={captureMsg}>
            {captureMsg}
          </span>
        ) : (
          <span className="query-hint">⌘+Enter で実行 (選択中は選択のみ)</span>
        )}

        {running && (
          <span className="query-meta mono running-elapsed">
            {(elapsedMs / 1000).toFixed(1)}s 経過
          </span>
        )}
        {!running && result && (
          <span className="query-meta mono">
            {result.rowsAffected !== null && result.rowsAffected !== undefined
              ? `${result.rowsAffected}行に影響`
              : result.pageable
                ? result.rows.length === 0
                  ? "0行"
                  : `${(result.offset + 1).toLocaleString()}〜${(
                      result.offset + result.rows.length
                    ).toLocaleString()}行目`
                : `${result.rows.length}行${result.hasMore ? " (先頭のみ表示)" : ""}`}
            {` — ${result.elapsedMs}ms`}
          </span>
        )}

        {result?.pageable && (result.offset > 0 || result.hasMore) && (
          <span className="pager">
            <button
              className="pager-btn"
              title="前の1000行"
              disabled={running || result.offset === 0}
              onClick={() =>
                onPage(activeIdx, Math.max(0, result.offset - QUERY_PAGE_SIZE))
              }
            >
              ‹
            </button>
            <button
              className="pager-btn"
              title="次の1000行"
              disabled={running || !result.hasMore}
              onClick={() => onPage(activeIdx, result.offset + QUERY_PAGE_SIZE)}
            >
              ›
            </button>
          </span>
        )}
      </div>

      <div
        className="row-splitter"
        title="ドラッグで高さを変更"
        onMouseDown={startResize}
      >
        <span className="grip" aria-hidden />
      </div>

      {/* 結果タブ (複数文実行時のみ) */}
      {results && results.length > 1 && (
        <div className="result-tabs">
          {results.map((s, i) => (
            <button
              key={i}
              className={"result-tab" + (i === activeIdx ? " active" : "")}
              title={s.sql}
              onClick={() => setActiveIdx(i)}
            >
              {statementLabel(s.sql, i)}
            </button>
          ))}
        </div>
      )}

      {/* 結果 */}
      <div className="query-result">
        {error && (
          <div className="result-banner ng query-error">
            <span className="dot" aria-hidden />
            <strong>エラー</strong>
            <span className="result-detail">{error}</span>
          </div>
        )}
        {!result ? (
          !error && (
            <div className="content-placeholder dim-center">
              SQLを実行すると結果がここに表示されます
            </div>
          )
        ) : result.rowsAffected !== null && result.rowsAffected !== undefined ? (
          <div className="content-placeholder dim-center">
            {result.rowsAffected}行に影響しました ({result.elapsedMs}ms)
          </div>
        ) : result.rows.length === 0 ? (
          <div className="content-placeholder dim-center">結果は0行でした</div>
        ) : isPlanResult(result.columns) ? (
          <PlanView lines={planLines(result.rows)} />
        ) : (
          <ResizableGrid
            columns={gridColumns}
            sort={gridSort}
            onSortToggle={toggleSort}
            rows={sortedRows.map((r) => {
              const cells = r.cells.map((v) =>
                v === null ? (
                  <span className="null-cell">NULL</span>
                ) : (
                  <span className="mono" title={v}>
                    {v}
                  </span>
                )
              );
              if (showRowNums) {
                cells.unshift(
                  <span className="mono row-num">
                    {(result?.offset ?? 0) + r.index + 1}
                  </span>
                );
              }
              return { key: String(r.index), cells };
            })}
          />
        )}
      </div>
    </div>
  );
}
