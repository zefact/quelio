import { useCallback, useEffect, useRef, useState } from "react";
import {
  addSqlHistory,
  checkKvDestructive,
  kvApply,
  kvExec,
  kvKeyDetail,
  kvScan,
} from "../api";
import { captureResults } from "../capture";
import { badgeStyle } from "../colors";
import { useResizableHeight } from "../hooks/useResizableHeight";
import { useResizableWidth } from "../hooks/useResizableWidth";
import type {
  KvBrowseState,
  KvChange,
  KvKeyDetail,
  KvKeyInfo,
  KvStatementResult,
  StatementResult,
  WorkTab,
} from "../types";
import { KvCommandEditor } from "./KvCommandEditor";
import { ConfirmDialog } from "./ConfirmDialog";
import { KvValueGrid } from "./KvValueGrid";
import { SelectMenu } from "./SelectMenu";
import { SqlLibraryMenu } from "./SqlLibraryMenu";
import { KvBulkDialog } from "./kvBulk/KvBulkDialog";

interface Props {
  tab: WorkTab;
  onSelectDb: (db: string) => void;
  /** コマンドエディタの内容変更 (タブ状態として保持) */
  onChangeSql: (sql: string) => void;
  /** コンソール表示の切替 (タブ状態として保持) */
  onSetConsole: (open: boolean) => void;
  /** コンソール実行結果の保存 (タブ状態として保持) */
  onKvOutput: (results: KvStatementResult[], error: string | null) => void;
  /** キーブラウザの状態保存 (タブを切り替えても戻せるように) */
  onKvBrowse: (state: KvBrowseState) => void;
}

/** 破壊的なため実行前に確認するコマンド */
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
  onKvBrowse,
}: Props) {
  const { profile, databases, selectedDb } = tab;
  const db = selectedDb ?? "0";
  // コンソール関連の状態はタブ側 (WorkTab) に持たせ、タブ切替後も維持する
  const consoleOpen = tab.view === "query";
  const command = tab.editor.sql;
  const results = tab.kv.results ?? [];
  const execError = tab.kv.execError ?? null;

  // ---------- キーブラウザ ----------
  // タブを離れて戻ってきたときは、前回の一覧・選択をそのまま復元する
  const saved = tab.kv.browse;
  const [pattern, setPattern] = useState(saved?.pattern ?? "*");
  const [keys, setKeys] = useState<KvKeyInfo[]>(saved?.keys ?? []);
  const [cursor, setCursor] = useState(saved?.cursor ?? "0");
  const [done, setDone] = useState(saved?.done ?? true);
  const [dbsize, setDbsize] = useState(saved?.dbsize ?? -1);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** キーの検索・一括削除の画面を出すか */
  const [showBulk, setShowBulk] = useState(false);

  // ---------- キー詳細 ----------
  const [selectedKey, setSelectedKey] = useState<string | null>(
    saved?.selectedKey ?? null
  );
  const [detail, setDetail] = useState<KvKeyDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  /** 値の整形表示 (JSON / PHPシリアライズ) */
  const [pretty, setPretty] = useState(false);
  /** キー名を変更中の入力値 (nullなら表示のみ) */
  const [keyDraft, setKeyDraft] = useState<string | null>(null);
  /** TTLを変更中の入力値 (秒。nullなら表示のみ) */
  const [ttlDraft, setTtlDraft] = useState<string | null>(null);
  /** キー操作 (改名・TTL・削除・作成) のエラー */
  const [keyError, setKeyError] = useState<string | null>(null);
  /** 直近の失敗理由 (確認ダイアログへその場で渡すため、stateとは別に持つ) */
  const lastKeyError = useRef<string | null>(null);
  /** 読み取り専用の接続では、キーの作成・変更・削除を出さない */
  const readOnly = tab.profile.readOnly ?? false;
  /** 削除の確認中のキー */
  const [deleting, setDeleting] = useState<string | null>(null);
  /** 新規キーの入力 (nullなら作成していない) */
  const [newKey, setNewKey] = useState<{
    key: string;
    type: string;
    field: string;
    value: string;
  } | null>(null);
  const [paneWidth, startPaneResize] = useResizableWidth(260, 170, 520);

  // ---------- コンソール ----------
  const [running, setRunning] = useState(false);
  /** 確認待ちの破壊的コマンド (複数行のときは全部出す) */
  const [confirmCmd, setConfirmCmd] = useState<string[] | null>(null);
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

  /** 直前に読み込んだ「タブ+DB」。同じValkeyタブ同士の切替でも作り直すため両方見る */
  const loaded = useRef<string | null>(null);

  // タブ・DBが変わったら、そのタブの保存内容を復元する。
  // 保存が無い (初めて開く / DBを切り替えた) ときだけ先頭から読み込む
  useEffect(() => {
    const id = `${tab.key}\u0000${db}`;
    if (loaded.current === id) return;
    loaded.current = id;
    const keep = tab.kv.browse;
    setDetail(null);
    if (keep && keep.db === db && keep.keys.length > 0) {
      setPattern(keep.pattern);
      setKeys(keep.keys);
      setCursor(keep.cursor);
      setDone(keep.done);
      setDbsize(keep.dbsize);
      setSelectedKey(keep.selectedKey);
      if (keep.selectedKey) void openKey(keep.selectedKey);
      return;
    }
    const pat = keep?.db === db ? (keep?.pattern ?? "*") : "*";
    setPattern(pat);
    setKeys([]);
    setCursor("0");
    setSelectedKey(null);
    void scan(true, pat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.key, db]);

  // 一覧・選択が変わったらタブ側へ保存する (タブ切替で消えないように)
  useEffect(() => {
    onKvBrowse({ db, pattern, keys, cursor, done, dbsize, selectedKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, pattern, keys, cursor, done, dbsize, selectedKey]);

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

  // キー名・TTLの編集や新規キーの入力は、フォーカスが外れていてもEscで取り消す
  useEffect(() => {
    if (keyDraft === null && ttlDraft === null && !newKey) return;
    const onKey = (e: KeyboardEvent) => {
      // 確認ダイアログなど手前の画面が処理済みなら何もしない。
      // 日本語入力の変換を取り消したときのEscも拾わない
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      // 確認ダイアログが出ている間は、裏の編集内容を消さない
      if (document.querySelector(".modal-overlay")) return;
      e.preventDefault();
      setKeyDraft(null);
      setTtlDraft(null);
      setNewKey(null);
      setKeyError(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyDraft, ttlDraft, newKey]);

  /** キーへの変更を実行する (失敗したらエラーを表示して何もしない) */
  const applyKey = async (change: KvChange): Promise<boolean> => {
    try {
      await kvApply(tab.key, db, change);
      setKeyError(null);
      return true;
    } catch (e) {
      setKeyError(String(e));
      lastKeyError.current = String(e);
      return false;
    }
  };

  /** キー名の変更を確定する */
  const commitRename = async () => {
    const next = (keyDraft ?? "").trim();
    if (!detail || next === "" || next === detail.key) {
      setKeyDraft(null);
      return;
    }
    const ok = await applyKey({
      kind: "rename",
      key: detail.key,
      newKey: next,
    });
    if (!ok) return;
    setKeyDraft(null);
    await scan(true);
    await openKey(next);
  };

  /** TTLの変更を確定する (0以下で無期限) */
  const commitTtl = async () => {
    const n = Number.parseInt((ttlDraft ?? "").trim(), 10);
    if (!detail || Number.isNaN(n)) {
      setTtlDraft(null);
      return;
    }
    const ok = await applyKey({ kind: "expire", key: detail.key, ttl: n });
    if (!ok) return;
    setTtlDraft(null);
    await scan(true);
    await openKey(detail.key);
  };

  /** キーを削除する (確認モーダルから呼ばれる) */
  const commitDelete = async (key: string) => {
    const ok = await applyKey({ kind: "deleteKey", key });
    // 失敗したら閉じない (消えていないのに消えたように見せない)。
    // 投げた文字列は確認ダイアログがそのまま表示する
    if (!ok) throw lastKeyError.current ?? "削除できませんでした";
    setDeleting(null);
    setSelectedKey(null);
    setDetail(null);
    await scan(true);
  };

  /** 新しいキーを作る */
  const commitCreate = async () => {
    if (!newKey) return;
    const key = newKey.key.trim();
    if (key === "") return;
    const ok = await applyKey({
      kind: "createKey",
      key,
      kvType: newKey.type,
      row: { field: newKey.field, value: newKey.value },
    });
    if (!ok) return;
    setNewKey(null);
    await scan(true);
    await openKey(key);
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
    // 破壊的コマンドは確認してから実行する。
    // 判定はバックエンドに任せる (実行時のガードと同じ基準にするため)
    if (!confirmed) {
      const danger = await checkKvDestructive(lines).catch(() => []);
      if (danger.length > 0) {
        setConfirmCmd(danger);
        return;
      }
    }
    addSqlHistory(text).catch(() => {});
    setRunning(true);
    setCaptureMsg(null);
    try {
      const out = await kvExec(tab.key, db, lines, confirmed);
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
              className="pane-icon-btn has-tooltip tooltip-left"
              data-tooltip={
                readOnly
                  ? "読み取り専用の接続では作成できません"
                  : "キーを新規作成"
              }
              disabled={readOnly}
              onClick={() => {
                setKeyError(null);
                setNewKey({ key: "", type: "string", field: "", value: "" });
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <button
              className="pane-icon-btn has-tooltip tooltip-left"
              data-tooltip="値の検索とキーの一括削除"
              aria-label="キーの検索・一括削除"
              onClick={() => setShowBulk(true)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="2" />
                <path d="M15.5 15.5L20 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
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
              // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") scan(true);
            }}
          />
          {newKey && (
            <div className="kv-new-key">
              <input
                className="mono"
                autoFocus
                placeholder="キー名"
                value={newKey.key}
                onChange={(e) => setNewKey({ ...newKey, key: e.target.value })}
                onKeyDown={(e) => {
                  // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setNewKey(null);
                    setKeyError(null);
                  }
                }}
              />
              <select
                className="cell-select"
                value={newKey.type}
                onChange={(e) => setNewKey({ ...newKey, type: e.target.value })}
              >
                {["string", "hash", "list", "set", "zset"].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {(newKey.type === "hash" || newKey.type === "zset") && (
                <input
                  className="mono"
                  placeholder={newKey.type === "hash" ? "フィールド" : "スコア"}
                  value={newKey.field}
                  onChange={(e) =>
                    setNewKey({ ...newKey, field: e.target.value })
                  }
                />
              )}
              <input
                className="mono"
                placeholder={newKey.type === "zset" ? "メンバー" : "値"}
                value={newKey.value}
                onChange={(e) => setNewKey({ ...newKey, value: e.target.value })}
                onKeyDown={(e) => {
                  // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitCreate();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setNewKey(null);
                    setKeyError(null);
                  }
                }}
              />
              <div className="kv-new-key-foot">
                <span className="ddl-bar-text">
                  <kbd>Enter</kbd> で作成 / <kbd>Esc</kbd> で取り消し
                </span>
                <span className="toolbar-spacer" />
                <button className="sql-btn" onClick={() => void commitCreate()}>
                  作成
                </button>
              </div>
              {keyError && <p className="new-table-error">{keyError}</p>}
            </div>
          )}
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
                {keyDraft !== null ? (
                  <input
                    className="cell-input mono kv-key-input"
                    autoFocus
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    onKeyDown={(e) => {
                      // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
                      if (e.nativeEvent.isComposing) return;
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setKeyDraft(null);
                        setKeyError(null);
                      }
                    }}
                  />
                ) : (
                  <span
                    className="kv-detail-key mono"
                    title={
                      readOnly
                        ? "読み取り専用の接続のため変更できません"
                        : "ダブルクリックでキー名を変更"
                    }
                    onDoubleClick={() => {
                      if (readOnly) return;
                      setKeyError(null);
                      setKeyDraft(detail.key);
                    }}
                  >
                    {detail.key}
                  </span>
                )}
                {typeBadge(detail.type)}
                <span className="toolbar-spacer" />
                <button
                  className={"sql-btn kv-fmt-btn" + (pretty ? " active" : "")}
                  title="JSONやPHPシリアライズの値を見やすく整形して表示"
                  onClick={() => setPretty(!pretty)}
                >
                  整形
                </button>
                {!readOnly && (
                  <button
                    className="sql-btn danger"
                    title="このキーを削除します"
                    onClick={() => setDeleting(detail.key)}
                  >
                    キーを削除
                  </button>
                )}
              </div>
              <div className="kv-detail-meta mono">
                <span>
                  TTL:{" "}
                  {ttlDraft !== null ? (
                    <span className="kv-ttl-edit">
                      <input
                        className="cell-input mono kv-ttl-input"
                        autoFocus
                        type="number"
                        min={0}
                        value={ttlDraft}
                        onChange={(e) => setTtlDraft(e.target.value)}
                        onKeyDown={(e) => {
                          // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
                          if (e.nativeEvent.isComposing) return;
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void commitTtl();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setTtlDraft(null);
                            setKeyError(null);
                          }
                        }}
                      />
                      <span className="kv-ttl-unit">秒 (0で無期限)</span>
                    </span>
                  ) : (
                    <span
                      className={readOnly ? "" : "kv-editable"}
                      title={
                        readOnly
                          ? "読み取り専用の接続のため変更できません"
                          : "ダブルクリックで変更 (秒。0で無期限に戻します)"
                      }
                      onDoubleClick={() => {
                        if (readOnly) return;
                        setKeyError(null);
                        setTtlDraft(detail.ttl < 0 ? "0" : String(detail.ttl));
                      }}
                    >
                      {detail.ttl < 0
                        ? "無期限"
                        : `${detail.ttl.toLocaleString()}秒` +
                          (detail.ttl >= 60 ? ` (約${ttlLabel(detail.ttl)})` : "")}
                    </span>
                  )}
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
                  {keyError && (
                    <div className="result-banner ng kv-edit-error">
                      <span className="dot" aria-hidden />
                      <span className="result-detail">{keyError}</span>
                    </div>
                  )}
                  <KvValueGrid
                    sessionId={tab.key}
                    database={db}
                    detail={detail}
                    pretty={pretty}
                    readOnly={tab.profile.readOnly ?? false}
                    onReload={() => {
                      void openKey(detail.key);
                      void scan(true);
                    }}
                  />
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

      {/* キー削除の確認 (取り消せないため確認する) */}
      {deleting && (
        <ConfirmDialog
          title="キーを削除します"
          target={deleting}
          onCancel={() => setDeleting(null)}
          onConfirm={() => commitDelete(deleting)}
        >
          値はすべて失われます。取り消しはできません。
        </ConfirmDialog>
      )}

      {/* 破壊的コマンドの確認ダイアログ */}
      {confirmCmd && (
        <ConfirmDialog
          title="このコマンドを実行します"
          confirmLabel="実行する"
          onCancel={() => setConfirmCmd(null)}
          onConfirm={() => {
            setConfirmCmd(null);
            runCommands(true);
          }}
        >
          データの削除や高負荷につながる可能性があります。
          <ul className="column-warn-list">
            {confirmCmd.map((c) => (
              <li key={c} className="mono">
                {c}
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}

      {showBulk && (
        <KvBulkDialog
          sessionId={tab.key}
          database={db}
          /* 一括削除の欄に "*" が入ったまま始まらないようにする */
          initialPattern={pattern === "*" ? "" : pattern}
          readOnly={readOnly}
          onClose={() => setShowBulk(false)}
          onDeleted={() => scan(true)}
          onPickKey={(k) => void openKey(k)}
        />
      )}
    </div>
  );
}
