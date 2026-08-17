import { useCallback, useEffect, useRef, useState } from "react";
import { addSqlHistory, kvExec, kvKeyDetail, kvScan } from "../api";
import { captureResults } from "../capture";
import { badgeStyle } from "../colors";
import { useResizableHeight } from "../hooks/useResizableHeight";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { tryFormatValue } from "../kvFormat";
import type {
  KvKeyDetail,
  KvKeyInfo,
  KvStatementResult,
  StatementResult,
  WorkTab,
} from "../types";
import { KvCommandEditor } from "./KvCommandEditor";
import { SelectMenu } from "./SelectMenu";
import { SqlLibraryMenu } from "./SqlLibraryMenu";

interface Props {
  tab: WorkTab;
  onSelectDb: (db: string) => void;
  /** コマンドエディタの内容変更 (タブ状態として保持) */
  onChangeSql: (sql: string) => void;
  /** コンソール表示の切替 (タブ状態として保持) */
  onSetConsole: (open: boolean) => void;
  /** コンソール実行結果の保存 (タブ状態として保持) */
  onKvOutput: (results: KvStatementResult[], error: string | null) => void;
}

/** 破壊的なため実行前に確認するコマンド */
const DANGEROUS = ["FLUSHALL", "FLUSHDB", "SHUTDOWN", "DEBUG", "KEYS", "DEL"];

/** TTLの表示 (-1: 無期限) */
function ttlLabel(ttl: number): string {
  if (ttl < 0) return "∞";
  if (ttl >= 86400) return `${Math.floor(ttl / 86400)}d`;
  if (ttl >= 3600) return `${Math.floor(ttl / 3600)}h`;
  if (ttl >= 60) return `${Math.floor(ttl / 60)}m`;
  return `${ttl}s`;
}

/** 結果タブのラベル: "1: GET" のようにコマンド名を添える */
function commandLabel(command: string, index: number): string {
  const head = command.trim().split(/\s+/)[0]?.toUpperCase() ?? "CMD";
  return `${index + 1}: ${head}`;
}

/** キャプチャ描画 (SQLと共通のcanvas描画) に渡すため結果を変換する */
function toStatementResults(rs: KvStatementResult[]): StatementResult[] {
  return rs.map((r) => ({
    sql: r.command,
    result: {
      columns: ["結果"],
      rows: r.lines.map((l) => [l]),
      offset: 0,
      hasMore: false,
      pageable: false,
      elapsedMs: r.elapsedMs,
    },
  }));
}

/** 型に応じた「中身の量」の表示 (stringは長さ、コレクション型は件数) */
function countLabel(type: string, total: number): string {
  switch (type) {
    case "string":
      return `サイズ: ${bytesLabel(total)}`;
    case "hash":
      return `フィールド数: ${total.toLocaleString()}`;
    case "list":
      return `要素数: ${total.toLocaleString()}`;
    case "set":
    case "zset":
      return `メンバー数: ${total.toLocaleString()}`;
    case "stream":
      return `エントリ数: ${total.toLocaleString()}`;
    default:
      return `要素数: ${total.toLocaleString()}`;
  }
}

/** バイト数の表示 */
function bytesLabel(n: number | null): string {
  if (n === null) return "-";
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Valkey接続のセッション画面 (キーブラウザ + キー詳細 + コマンドコンソール) */
export function KvSessionView({
  tab,
  onSelectDb,
  onChangeSql,
  onSetConsole,
  onKvOutput,
}: Props) {
  const { profile, databases, selectedDb } = tab;
  const db = selectedDb ?? "0";
  // コンソール関連の状態はタブ側 (WorkTab) に持たせ、タブ切替後も維持する
  const consoleOpen = tab.view === "query";
  const command = tab.sql;
  const results = tab.kvResults ?? [];
  const execError = tab.kvExecError ?? null;

  // ---------- キーブラウザ ----------
  const [pattern, setPattern] = useState("*");
  const [keys, setKeys] = useState<KvKeyInfo[]>([]);
  const [cursor, setCursor] = useState("0");
  const [done, setDone] = useState(true);
  const [dbsize, setDbsize] = useState(-1);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---------- キー詳細 ----------
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<KvKeyDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  /** 値の整形表示 (JSON / PHPシリアライズ) */
  const [pretty, setPretty] = useState(false);
  const [paneWidth, startPaneResize] = useResizableWidth(260, 170, 520);

  // ---------- コンソール ----------
  const [running, setRunning] = useState(false);
  const [confirmCmd, setConfirmCmd] = useState<string | null>(null);
  /** 複数コマンド実行時に表示中の結果タブ */
  const [activeIdx, setActiveIdx] = useState(0);
  /** 実行時に結果をPNG保存する */
  const [captureOn, setCaptureOn] = useState(false);
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);
  const outRef = useRef<HTMLDivElement>(null);
  /** エディタ高さ (SQL画面と同じくスプリッタで変更) */
  const [editorHeight, startResize] = useResizableHeight(180, 72, 4000);

  /** キー一覧を取得する (fresh=trueで先頭から取り直し) */
  const scan = useCallback(
    async (fresh: boolean, pat?: string) => {
      setScanning(true);
      setError(null);
      try {
        const r = await kvScan(
          tab.key,
          db,
          pat ?? pattern,
          fresh ? "0" : cursor
        );
        setKeys((prev) => (fresh ? r.entries : [...prev, ...r.entries]));
        setCursor(r.cursor);
        setDone(r.done);
        setDbsize(r.dbsize);
      } catch (e) {
        setError(String(e));
      } finally {
        setScanning(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.key, db, pattern, cursor]
  );

  // 初回・DB切替時は先頭から読み込む
  useEffect(() => {
    setSelectedKey(null);
    setDetail(null);
    scan(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.key, db]);

  /** キー選択 → 詳細を取得 */
  const openKey = async (key: string) => {
    setSelectedKey(key);
    onSetConsole(false);
    setLoadingDetail(true);
    try {
      setDetail(await kvKeyDetail(tab.key, db, key));
      setError(null);
    } catch (e) {
      setDetail(null);
      setError(String(e));
    } finally {
      setLoadingDetail(false);
    }
  };

  /** コマンド実行 (確認済みならconfirmed=true) */
  const runCommands = async (confirmed = false) => {
    const text = command.trim();
    if (!text || running) return;
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    if (lines.length === 0) return;
    // 破壊的コマンドは確認してから実行する
    if (!confirmed) {
      const danger = lines.find((l) =>
        DANGEROUS.includes(l.split(/\s+/)[0].toUpperCase())
      );
      if (danger) {
        setConfirmCmd(danger);
        return;
      }
    }
    addSqlHistory(text).catch(() => {});
    setRunning(true);
    setCaptureMsg(null);
    try {
      const out = await kvExec(tab.key, db, lines);
      onKvOutput(out.statements, out.error ?? null);
      setActiveIdx(0);
      // キャプチャON: SQLと同じcanvas描画で全結果をPNG保存する
      if (captureOn && out.statements.length > 0) {
        setCaptureMsg("キャプチャ保存中...");
        captureResults(toStatementResults(out.statements))
          .then((paths) =>
            setCaptureMsg(`キャプチャ保存: ${paths.length}件 → 保存先フォルダ`)
          )
          .catch((err) => setCaptureMsg(`キャプチャ失敗: ${err}`));
      }
    } catch (e) {
      onKvOutput([], String(e));
    } finally {
      setRunning(false);
      requestAnimationFrame(() => {
        outRef.current?.scrollTo({ top: 0 });
      });
    }
  };

  const typeBadge = (t: string) => (
    <span className={`kv-type kv-type-${t}`}>{t}</span>
  );

  // 表示中の結果 (タブ数が減った場合に備えて範囲内に丸める)
  const shownIdx = Math.min(activeIdx, Math.max(0, results.length - 1));
  const shownResult = results[shownIdx];

  return (
    <div className="session">
      {/* ツールバー */}
      <div className="session-toolbar">
        <span className="db-badge valkey" style={badgeStyle(profile.color)}>
          Vk
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
          <span className="kv-db-label mono">DB</span>
          <SelectMenu
            className="mono"
            value={db}
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
          className={"sql-btn" + (consoleOpen ? " active" : "")}
          title="コマンドコンソール (⌘+Enterで実行)"
          onClick={() => onSetConsole(!consoleOpen)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M5 5l7 7-7 7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M13 19h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          コンソール
        </button>
      </div>

      {/* 本体 */}
      <div className="session-body">
        {/* 左ペイン: キーブラウザ */}
        <aside className="table-pane kv-pane" style={{ width: paneWidth }}>
          <div className="table-pane-head">
            <span>キー</span>
            <span className="panel-count">
              {keys.length}
              {dbsize >= 0 ? ` / ${dbsize}` : ""}
            </span>
            {/* テーブル一覧と同じ位置に再読み込みを置く (先頭からSCANし直す) */}
            <button
              className={
                "pane-icon-btn has-tooltip tooltip-left" +
                (scanning ? " spinning" : "")
              }
              data-tooltip="キー一覧を再読み込み"
              disabled={scanning}
              onClick={() => scan(true)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {/* 余白を右側に寄せて、見出し・件数・アイコンを左揃えにする */}
            <span className="toolbar-spacer" />
          </div>
          <input
            className="filter-input mono"
            placeholder="パターン (例: user:*)"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") scan(true);
            }}
          />
          <ul className="side-table-list kv-key-list">
            {keys.map((k) => (
              <li key={k.key}>
                <button
                  className={
                    "side-table-item kv-key-item" +
                    (selectedKey === k.key ? " selected" : "")
                  }
                  title={`${k.key} (${k.type}${k.ttl >= 0 ? ` / TTL ${k.ttl}秒` : ""})`}
                  onClick={() => openKey(k.key)}
                >
                  {typeBadge(k.type)}
                  <span className="kv-key-name mono">{k.key}</span>
                  <span className="kv-ttl mono">{ttlLabel(k.ttl)}</span>
                </button>
              </li>
            ))}
            {keys.length === 0 && !scanning && (
              <li className="table-pane-empty">キーがありません</li>
            )}
          </ul>
          <div className="kv-pane-foot">
            {/* 続きの読み込み専用 (先頭から取り直すのは見出し横の再読み込みボタン) */}
            <button
              className="btn-secondary kv-more-btn"
              disabled={scanning || done}
              title={
                done
                  ? "この条件のキーはすべて読み込み済みです"
                  : "続きのキーを読み込みます"
              }
              onClick={() => scan(false)}
            >
              {scanning ? (
                <>
                  <span className="spinner" /> 読み込み中...
                </>
              ) : done ? (
                "すべて読み込み済み"
              ) : (
                "続きを読み込む"
              )}
            </button>
          </div>
        </aside>

        <div className="pane-splitter" onMouseDown={startPaneResize} />

        <main className="session-content kv-content">
          {error && (
            <div className="result-banner ng">
              <span className="dot" aria-hidden />
              <strong>エラー</strong>
              <span className="result-detail">{error}</span>
            </div>
          )}

          {consoleOpen ? (
            <div className="kv-console">
              <div
                className="sql-editor kv-cmd-editor"
                style={{ height: editorHeight }}
              >
                <KvCommandEditor
                  value={command}
                  placeholder={
                    "コマンドを入力 (1行1コマンド)  例: GET user:123 / HGETALL session:abc / TTL cache:top"
                  }
                  onChange={onChangeSql}
                  onRun={() => runCommands()}
                />
              </div>
              <div className="query-actions">
                <button
                  className="btn-primary"
                  disabled={running || !command.trim()}
                  onClick={() => runCommands()}
                >
                  {running ? (
                    <>
                      <span className="spinner light" /> 実行中...
                    </>
                  ) : (
                    "実行"
                  )}
                </button>
                <SqlLibraryMenu
                  currentSql={command}
                  onSelect={onChangeSql}
                  contentLabel="コマンド"
                />
                <label
                  className="switch capture-switch has-tooltip tooltip-left"
                  data-tooltip="実行時にコマンドと全結果タブをPNGで保存 (保存先は設定で変更できます)"
                >
                  <input
                    type="checkbox"
                    checked={captureOn}
                    disabled={running}
                    onChange={(e) => setCaptureOn(e.target.checked)}
                  />
                  <span className="track" aria-hidden />
                  <span className="switch-label">キャプチャ</span>
                </label>
                {captureMsg && (
                  <span className="capture-msg mono" title={captureMsg}>
                    {captureMsg}
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
              {execError && (
                <div className="result-banner ng">
                  <span className="dot" aria-hidden />
                  <strong>エラー</strong>
                  <span className="result-detail">{execError}</span>
                </div>
              )}
              {/* 結果タブ (複数コマンド実行時のみ) */}
              {results.length > 1 && (
                <div className="result-tabs">
                  {results.map((r, i) => (
                    <button
                      key={i}
                      className={
                        "result-tab" + (i === shownIdx ? " active" : "")
                      }
                      title={r.command}
                      onClick={() => setActiveIdx(i)}
                    >
                      {commandLabel(r.command, i)}
                    </button>
                  ))}
                </div>
              )}
              <div className="kv-out" ref={outRef}>
                {shownResult && (
                  <div className="kv-out-block">
                    <div className="kv-out-cmd mono">
                      <span className="kv-prompt">&gt;</span>{" "}
                      {shownResult.command}
                      <span className="kv-out-ms">
                        ({shownResult.elapsedMs} ms)
                      </span>
                    </div>
                    <pre className="kv-out-lines mono">
                      {shownResult.lines.join("\n")}
                    </pre>
                  </div>
                )}
                {results.length === 0 && !execError && (
                  <div className="content-placeholder dim-center">
                    実行結果がここに表示されます
                  </div>
                )}
              </div>
            </div>
          ) : detail ? (
            <div className="kv-detail">
              <div className="kv-detail-head">
                <span className="kv-detail-key mono">{detail.key}</span>
                {typeBadge(detail.type)}
                <span className="toolbar-spacer" />
                <button
                  className={"sql-btn kv-fmt-btn" + (pretty ? " active" : "")}
                  title="JSONやPHPシリアライズの値を見やすく整形して表示"
                  onClick={() => setPretty(!pretty)}
                >
                  整形
                </button>
              </div>
              <div className="kv-detail-meta mono">
                <span>
                  TTL:{" "}
                  {detail.ttl < 0
                    ? "無期限"
                    : `${detail.ttl.toLocaleString()}秒` +
                      (detail.ttl >= 60 ? ` (約${ttlLabel(detail.ttl)})` : "")}
                </span>
                <span>{countLabel(detail.type, detail.total)}</span>
                <span>メモリ: {bytesLabel(detail.memory)}</span>
                {detail.encoding && <span>encoding: {detail.encoding}</span>}
              </div>
              {loadingDetail ? (
                <div className="content-placeholder dim-center">
                  <span className="spinner accent" /> 読み込み中...
                </div>
              ) : (
                <>
                  <div className="grid-wrap kv-value-wrap">
                    <table className="grid mono kv-value-grid">
                      <thead>
                        <tr>
                          <th>{detail.cols[0]}</th>
                          <th>{detail.cols[1]}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.rows.map(([a, b], i) => (
                          <tr key={i}>
                            <td className="kv-cell-a">{a}</td>
                            <td className="kv-cell-b">
                              {pretty ? (tryFormatValue(b) ?? b) : b}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {detail.truncated && (
                    <div className="kv-truncated">
                      {detail.type === "string"
                        ? `値が長いため先頭のみ表示しています (全体: ${bytesLabel(detail.total)})`
                        : `先頭${detail.rows.length}件のみ表示しています (全${detail.total.toLocaleString()}件)`}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="content-placeholder dim-center">
              {loadingDetail ? (
                <>
                  <span className="spinner accent" /> 読み込み中...
                </>
              ) : (
                "左の一覧からキーを選択してください"
              )}
            </div>
          )}
        </main>
      </div>

      {/* 破壊的コマンドの確認ダイアログ */}
      {confirmCmd && (
        <div className="er-modal-overlay" onMouseDown={() => setConfirmCmd(null)}>
          <div className="er-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="er-modal-head">
              <div className="er-modal-icon danger">✕</div>
              <div>
                <div className="er-modal-title">コマンドの実行確認</div>
                <div className="er-modal-sub">
                  データの削除や高負荷につながる可能性があります
                </div>
              </div>
            </div>
            <p className="er-modal-body mono">{confirmCmd}</p>
            <div className="er-modal-actions">
              <button
                className="btn-ghost er-modal-cancel"
                onClick={() => setConfirmCmd(null)}
              >
                キャンセル
              </button>
              <button
                className="btn-primary btn-delete"
                onClick={() => {
                  setConfirmCmd(null);
                  runCommands(true);
                }}
              >
                実行する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
