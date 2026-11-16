import { useEffect, useRef, useState } from "react";
import { useModal } from "../hooks/useModal";
import { open } from "@tauri-apps/plugin-dialog";
import {
  cancelJob,
  checkExportTarget,
  defaultExportTarget,
  detectTools,
  jobStatus,
  startExport,
  startImport,
} from "../api";
import { stageDroppedFile } from "../uploadFile";
import { fmtBytes } from "../format";
import {
  badPattern,
  DEFAULT_NAME_PATTERN,
  expandPattern,
  folderName,
  joinPath,
  PATTERN_TOKENS,
  splitPath,
} from "../dumpTarget";
import { dbBadgeLabel } from "../colors";
import { RevealButton } from "./RevealButton";
import { fmtDuration, fmtRemaining, pushSample, remainingSeconds, type EtaSample } from "../jobEta";
import type { DbType, DumpEngine, ExportMode, ExportTable } from "../types";

interface JobView {
  jobId: string;
  running: boolean;
  bytes: number;
  total: number | null;
  error: string | null;
  outPath: string | null;
  progress: number | null;
  stage: string | null;
  notes: string[];
  /** 始めた時刻 (経過時間の表示用) */
  startedAt: number;
  /** 終わった時刻 */
  endedAt: number | null;
  /** 残りの秒数の見積もり */
  remaining: number | null;
}

/** ジョブの進捗をポーリングする共通フック */
function useJob() {
  const [job, setJob] = useState<JobView | null>(null);
  const timer = useRef<number | null>(null);
  const samples = useRef<EtaSample[]>([]);

  const stop = () => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  };

  const watch = (jobId: string) => {
    stop();
    const startedAt = Date.now();
    samples.current = [];
    timer.current = window.setInterval(async () => {
      try {
        const s = await jobStatus(jobId);
        const now = Date.now();
        if (s.progress !== null) {
          samples.current = pushSample(samples.current, { at: now, progress: s.progress });
        }
        setJob({
          jobId,
          running: s.running,
          bytes: s.bytes,
          total: s.total,
          error: s.error,
          outPath: s.outPath,
          progress: s.progress,
          stage: s.stage,
          notes: s.notes ?? [],
          startedAt,
          endedAt: s.running ? null : now,
          remaining: s.running ? remainingSeconds(samples.current) : null,
        });
        if (!s.running) stop();
      } catch {
        stop();
      }
    }, 500);
    setJob({
      jobId,
      running: true,
      bytes: 0,
      total: null,
      error: null,
      outPath: null,
      progress: null,
      stage: null,
      notes: [],
      startedAt,
      endedAt: null,
      remaining: null,
    });
  };

  useEffect(() => stop, []);
  return { job, setJob, watch };
}

/** 経過時間を1秒ごとに数え直す (ポーリングの間も表示を進める) */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return now;
}

/** 進捗パネルの小さな数字 (ラベルと値) */
function JobStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="job-stat">
      <span className="job-stat-label">{label}</span>
      <span className="job-stat-value mono">{value}</span>
    </div>
  );
}

function JobProgress({ job, kind }: { job: JobView; kind: "export" | "import" }) {
  const now = useNow(job.running);
  const ratio =
    job.progress !== null
      ? job.progress
      : job.total && job.total > 0
        ? job.bytes / job.total
        : null;
  // 大きなジョブは1%が長いので、小数1桁まで出す
  const pct = ratio !== null ? Math.min(100, Math.floor(ratio * 1000) / 10) : null;
  const elapsed = ((job.endedAt ?? now) - job.startedAt) / 1000;
  const verb = kind === "export" ? "書き出し" : "実行";
  // ファイル名だけを大きく見せる (場所はボタンで開ける)
  const fileName = job.outPath ? job.outPath.split(/[\\/]/).pop() : null;
  return (
    <div className="job-progress">
      {job.running ? (
        <div className="job-panel">
          <div className="job-panel-head">
            <span className="job-spinner" aria-hidden />
            <span className="job-panel-title">{verb}ています</span>
            <span className="toolbar-spacer" />
            <span className="job-big-pct mono">
              {pct !== null ? (
                <>
                  {pct.toFixed(1)}
                  <small>%</small>
                </>
              ) : (
                ""
              )}
            </span>
          </div>
          <div className="job-bar">
            <div
              className={"job-bar-fill" + (pct === null ? " indeterminate" : "")}
              style={pct !== null ? { width: `${pct}%` } : undefined}
            />
          </div>
          <div className="job-stats">
            <JobStat
              label={kind === "export" ? "書き出した量" : "実行した量"}
              value={fmtBytes(job.bytes) + (job.total ? ` / ${fmtBytes(job.total)}` : "")}
            />
            <JobStat label="経過" value={fmtDuration(elapsed)} />
            <JobStat
              label="残り"
              value={job.remaining !== null ? fmtRemaining(job.remaining) : "計算中…"}
            />
          </div>
          {job.stage && (
            <div className="job-stage mono" title={job.stage}>
              {job.stage}
            </div>
          )}
        </div>
      ) : job.error ? (
        <div className="job-result ng">
          <span className="job-result-icon" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </span>
          <div className="job-result-body">
            <strong>{verb}に失敗しました</strong>
            <span className="job-error">{job.error}</span>
          </div>
        </div>
      ) : (
        <div className="job-result ok">
          <span className="job-result-icon" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div className="job-result-body">
            <strong>{verb}が終わりました</strong>
            {fileName && <span className="job-result-file mono">{fileName}</span>}
            <span className="job-result-meta mono">
              {fmtBytes(job.bytes)} ・ {fmtDuration(elapsed)}
            </span>
          </div>
          {job.outPath && <RevealButton path={job.outPath} />}
        </div>
      )}
      {!job.running && job.notes.length > 0 && (
        <div className="result-banner warn job-notes">
          <span className="dot" aria-hidden />
          <ul className="result-detail">
            {job.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 実行方法の選択を、次に開いたときにも引き継ぐ */
const ENGINE_KEY = "quelio.dumpEngine";

function useEngine(dbType: DbType): [DumpEngine, (e: DumpEngine) => void] {
  const [engine, setEngine] = useState<DumpEngine>(() => {
    try {
      return localStorage.getItem(ENGINE_KEY) === "tool" ? "tool" : "native";
    } catch {
      return "native";
    }
  });
  const choose = (e: DumpEngine) => {
    setEngine(e);
    try {
      localStorage.setItem(ENGINE_KEY, e);
    } catch {
      /* 残せなくても、今回の選択は効く */
    }
  };
  // SQLiteには外部ツールの道が無い
  return [dbType === "sqlite" ? "native" : engine, choose];
}

/** 使う外部ツールの名前 */
function toolName(dbType: DbType, kind: "export" | "import"): string {
  if (dbType === "mysql") return kind === "export" ? "mysqldump" : "mysql";
  return kind === "export" ? "pg_dump" : "psql";
}

/** 選択肢をカードで並べる (ラジオボタンの代わり) */
function ChoiceCard({
  name,
  checked,
  disabled,
  onChange,
  icon,
  title,
  desc,
  badge,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  icon: React.ReactNode;
  title: string;
  desc: string;
  badge?: string;
}) {
  return (
    <label className={"choice-card" + (checked ? " on" : "") + (disabled ? " disabled" : "")}>
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="choice-icon" aria-hidden>
        {icon}
      </span>
      <span className="choice-text">
        <span className="choice-title">
          {title}
          {badge && <span className="choice-badge">{badge}</span>}
        </span>
        <span className="choice-desc">{desc}</span>
      </span>
    </label>
  );
}

/** 見出し付きのまとまり */
function Section({
  label,
  extra,
  children,
}: {
  label: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="tf-section">
      <div className="tf-label">
        {label}
        {extra}
      </div>
      {children}
    </section>
  );
}

const ICON_BOLT = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
  </svg>
);
const ICON_TERMINAL = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
    <path d="M7 10l3 2.5L7 15M12.5 15.5H17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Quelio自身でするか、外部ツールを使うかの選択 */
function EngineSelect({
  dbType,
  kind,
  engine,
  disabled,
  onChange,
}: {
  dbType: DbType;
  kind: "export" | "import";
  engine: DumpEngine;
  disabled?: boolean;
  onChange: (e: DumpEngine) => void;
}) {
  if (dbType === "sqlite") return null;
  const tool = toolName(dbType, kind);
  return (
    <Section label="実行方法">
      <div className="choice-grid cols-2">
        <ChoiceCard
          name={`engine-${kind}`}
          checked={engine === "native"}
          disabled={disabled}
          onChange={() => onChange("native")}
          icon={ICON_BOLT}
          title="Quelioで実行"
          badge="おすすめ"
          desc="外部ツール不要。進み具合と残り時間を表示します"
        />
        <ChoiceCard
          name={`engine-${kind}`}
          checked={engine === "tool"}
          disabled={disabled}
          onChange={() => onChange("tool")}
          icon={ICON_TERMINAL}
          title={`${tool} を使う`}
          desc={`インストール済みの ${tool} で実行します`}
        />
      </div>
    </Section>
  );
}

/** ダイアログの見出し (何をするか・どの接続か) */
function TransferHead({
  kind,
  title,
  sub,
  dbType,
  connName,
  database,
  closeDisabled,
  onClose,
}: {
  kind: "export" | "import";
  title: string;
  sub: string;
  dbType: DbType;
  connName: string;
  database: string;
  closeDisabled?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="tf-head">
      <span className={"tf-head-icon " + kind} aria-hidden>
        {kind === "export" ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <ellipse cx="12" cy="5.5" rx="7" ry="2.8" stroke="currentColor" strokeWidth="1.7" />
            <path d="M5 5.5v6c0 1.5 3.1 2.8 7 2.8M19 5.5V10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <path d="M5 11.5v6c0 1.5 3.1 2.8 7 2.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <path d="M18 13v7m0 0l-2.8-2.8M18 20l2.8-2.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <ellipse cx="12" cy="5.5" rx="7" ry="2.8" stroke="currentColor" strokeWidth="1.7" />
            <path d="M5 5.5v6c0 1.5 3.1 2.8 7 2.8M19 5.5V10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <path d="M5 11.5v6c0 1.5 3.1 2.8 7 2.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <path d="M18 20v-7m0 0l-2.8 2.8M18 13l2.8 2.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <div className="tf-head-text">
        <span className="modal-title">{title}</span>
        <span className="tf-head-sub">{sub}</span>
        <span className="tf-head-target">
          <span className={`db-badge mini ${dbType}`}>{dbBadgeLabel(dbType)}</span>
          <span className="mono">{connName}</span>
          {dbType !== "sqlite" && (
            <>
              <span className="tf-head-sep">/</span>
              <span className="mono">{database}</span>
            </>
          )}
        </span>
      </div>
      <button
        className="modal-close"
        onClick={onClose}
        disabled={closeDisabled}
        title="閉じる"
      >
        ×
      </button>
    </div>
  );
}

interface ExportProps {
  sessionId: string;
  database: string;
  connName: string;
  dbType: DbType;
  tables: ExportTable[];
  onClose: () => void;
  /** 設定画面を開く (外部ツールが見つからないとき) */
  onOpenSettings?: () => void;
}

/**
 * 必要な外部ツールが使えるかを、ダイアログを開いた時点で確かめる。
 * 開始してから「見つかりません」と言われるのを避ける
 */
function useToolCheck(dbType: DbType, kind: "export" | "import", engine: DumpEngine) {
  const [missing, setMissing] = useState<string | null>(null);
  const [checking, setChecking] = useState(engine === "tool");
  useEffect(() => {
    // Quelio自身で動かすときは、外部ツールは要らない
    if (engine !== "tool") {
      setMissing(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const need = toolName(dbType, kind);
    let alive = true;
    detectTools()
      .then((list) => {
        if (!alive) return;
        const found = list.find((t) => t.tool === need);
        setMissing(found?.path ? null : need);
      })
      .catch(() => {
        // 調べられなかったときは止めない (開始時のエラーで分かる)
        if (alive) setMissing(null);
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [dbType, kind, engine]);
  return { missing, checking };
}

/** 外部ツールが見つからないときの案内 */
function ToolMissing({ tool, onOpenSettings }: { tool: string; onOpenSettings?: () => void }) {
  return (
    <div className="result-banner ng">
      <span className="dot" aria-hidden />
      <strong>{tool} が見つかりません</strong>
      <span className="result-detail">
        設定の「外部ツール」でパスを指定するか、インストールしてください
      </span>
      {onOpenSettings && (
        <>
          <span className="toolbar-spacer" />
          <button className="btn-secondary" onClick={onOpenSettings}>
            設定を開く
          </button>
        </>
      )}
    </div>
  );
}

/** 画面に出すテーブル名 (PostgreSQLはスキーマ付き) */
function tableLabel(t: ExportTable): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

/** 書き出す内容の選択肢 */
const MODES: { mode: ExportMode; title: string; desc: string; icon: React.ReactNode }[] = [
  {
    mode: "full",
    title: "スキーマ + データ",
    desc: "定義と全行。バックアップに",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <rect x="3.5" y="4" width="17" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
        <path d="M3.5 9h17M3.5 14.5h17M10 9v11" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    ),
  },
  {
    mode: "schema",
    title: "スキーマのみ",
    desc: "CREATE文だけ。構造の複製に",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <rect x="3.5" y="4" width="17" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.7" strokeDasharray="3 2.4" />
        <path d="M3.5 9h17" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    ),
  },
  {
    mode: "data",
    title: "データのみ",
    desc: "行だけ。既存のテーブルへ戻すときに",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M5 7h14M5 12h14M5 17h9" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      </svg>
    ),
  },
];

/** テーブルがこれより多いときは、初めは畳んでおく */
const CHIP_LIMIT = 16;

/** 対象テーブルの一覧 (多いときは畳む) */
function TableChips({ tables }: { tables: ExportTable[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? tables : tables.slice(0, CHIP_LIMIT);
  const rest = tables.length - shown.length;
  if (tables.length === 0) {
    return <div className="tf-empty">テーブルが選ばれていません</div>;
  }
  return (
    <div className="tf-chips">
      {shown.map((t) => (
        <span className="tf-chip mono" key={tableLabel(t)} title={tableLabel(t)}>
          {tableLabel(t)}
        </span>
      ))}
      {rest > 0 && (
        <button className="tf-chip more" onClick={() => setAll(true)}>
          ほか {rest} 件を表示
        </button>
      )}
    </div>
  );
}

/** 選んだ保存先フォルダとファイル名のパターンを、次に開いたときにも引き継ぐ */
const DIR_KEY = "quelio.dumpDir";
const PATTERN_KEY = "quelio.dumpNamePattern";

function loadPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function savePref(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* 残せなくても、今回の選択は効く */
  }
}

/**
 * 書き出す先 (フォルダとファイル名のパターン)。
 *
 * 既定は設定の保存先フォルダに {db}_{date}_{time}.sql。
 * パターンは書き出すときに日時などを埋めるので、続けて書き出しても上書きにならない。
 * フォルダもパターンも次回へ引き継ぐ
 */
function useExportTarget(sessionId: string, database: string) {
  const [defaultDir, setDefaultDir] = useState("");
  const [dir, setDirRaw] = useState("");
  const [db, setDb] = useState("");
  const [pattern, setPatternRaw] = useState(
    () => loadPref(PATTERN_KEY) || DEFAULT_NAME_PATTERN
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    defaultExportTarget(sessionId, database)
      .then((t) => {
        if (!alive) return;
        setDefaultDir(t.dir);
        setDirRaw(loadPref(DIR_KEY) || t.dir);
        setDb(t.db);
      })
      .catch((e) => alive && setLoadError(String(e)));
    return () => {
      alive = false;
    };
  }, [sessionId, database]);

  const setPattern = (p: string) => {
    setPatternRaw(p);
    savePref(PATTERN_KEY, p === DEFAULT_NAME_PATTERN ? null : p);
  };

  /** 保存するフォルダを選ぶ */
  const pickDir = async () => {
    const picked = await open({
      directory: true,
      defaultPath: dir || undefined,
      title: "SQLダンプを保存するフォルダ",
    }).catch(() => null);
    if (typeof picked !== "string") return;
    setDirRaw(picked);
    savePref(DIR_KEY, picked === defaultDir ? null : picked);
  };

  /** 既定のフォルダとパターンに戻す */
  const reset = () => {
    savePref(DIR_KEY, null);
    setDirRaw(defaultDir);
    setPattern(DEFAULT_NAME_PATTERN);
  };

  return {
    dir,
    db,
    pattern,
    ready: !!dir && !!db,
    customized:
      (!!defaultDir && dir !== defaultDir) || pattern !== DEFAULT_NAME_PATTERN,
    loadError,
    setPattern,
    pickDir,
    reset,
  };
}

/** パターンの入力欄の下に並べる、置き換えを差し込むボタン */
function PatternTokens({ onInsert }: { onInsert: (token: string) => void }) {
  return (
    <div className="tf-tokens">
      {PATTERN_TOKENS.filter((t) => t.main).map((t) => (
        <button
          key={t.token}
          className="tf-token has-tooltip tooltip-left"
          data-tooltip={t.label}
          // 押しても入力欄からフォーカスを奪わない (カーソル位置に差し込むため)
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onInsert(`{${t.token}}`)}
        >
          <span className="mono">{`{${t.token}}`}</span>
        </button>
      ))}
    </div>
  );
}

const ICON_FOLDER = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M3 7.5A2.5 2.5 0 015.5 5H10l2 2.5h6.5A2.5 2.5 0 0121 10v7.5a2.5 2.5 0 01-2.5 2.5h-13A2.5 2.5 0 013 17.5z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
  </svg>
);

/** 選択テーブルをSQLダンプへ書き出すダイアログ */
export function ExportDialog({
  sessionId,
  database,
  connName,
  dbType,
  tables,
  onClose,
  onOpenSettings,
}: ExportProps) {
  const [mode, setMode] = useState<ExportMode>("full");
  const [error, setError] = useState<string | null>(null);
  const { job, watch } = useJob();
  const [engine, setEngine] = useEngine(dbType);
  const { missing, checking } = useToolCheck(dbType, "export", engine);
  const running = !!job?.running;
  const target = useExportTarget(sessionId, database);
  /** 同じ名前のファイルがあり、上書きしてよいか尋ねているパス */
  const [overwriteAsk, setOverwriteAsk] = useState<string | null>(null);
  const patternError = badPattern(target.pattern);
  const patternRef = useRef<HTMLInputElement>(null);
  // 見本の日時は1秒ごとに進める (書き出すときの時刻で名前が決まることが分かるように)
  const now = useNow(!running);
  const vars = {
    db: target.db,
    conn: connName,
    mode,
    tables: tables.map(tableLabel),
  };
  const preview =
    target.ready && !patternError
      ? joinPath(target.dir, expandPattern(target.pattern, vars, new Date(now)))
      : "";

  /** カーソルの位置に置き換えを差し込む */
  const insertToken = (token: string) => {
    const el = patternRef.current;
    const p = target.pattern;
    const start = el?.selectionStart ?? p.length;
    const end = el?.selectionEnd ?? p.length;
    target.setPattern(p.slice(0, start) + token + p.slice(end));
    setOverwriteAsk(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const handleStart = async (overwrite = false) => {
    setError(null);
    if (patternError) {
      setError(patternError);
      return;
    }
    try {
      // 名前は押した時点の日時で決める。上書きを尋ねたときは、尋ねたパスのまま書く
      const path =
        overwrite && overwriteAsk
          ? overwriteAsk
          : joinPath(target.dir, expandPattern(target.pattern, vars, new Date()));
      const checked = await checkExportTarget(path);
      if (checked.exists && !overwrite) {
        setOverwriteAsk(checked.path);
        return;
      }
      setOverwriteAsk(null);
      const started = await startExport(
        sessionId,
        database,
        tables,
        mode,
        engine,
        checked.path
      );
      watch(started.jobId);
    } catch (e) {
      setError(String(e));
    }
  };

  // Escで閉じる・初期フォーカスは共通の作法にそろえる (実行中は閉じない)
  const boxRef = useModal(onClose, !running);
  const modeTitle = MODES.find((m) => m.mode === mode)?.title ?? "";

  return (
    <div className="modal-overlay" onMouseDown={running ? undefined : onClose}>
      <div
        className="modal transfer-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <TransferHead
          kind="export"
          title="SQLダンプ出力"
          sub="選んだテーブルをSQLファイルに書き出します"
          dbType={dbType}
          connName={connName}
          database={database}
          closeDisabled={running}
          onClose={onClose}
        />

        {running ? (
          // 実行中は設定を畳み、進み具合を主役にする
          <div className="tf-running-summary">
            <span>{tables.length}テーブル</span>
            <span className="tf-dot" aria-hidden />
            <span>{modeTitle}</span>
            <span className="tf-dot" aria-hidden />
            <span>{engine === "native" ? "Quelio" : toolName(dbType, "export")}</span>
          </div>
        ) : (
          <>
            <Section
              label="対象テーブル"
              extra={<span className="tf-count">{tables.length}</span>}
            >
              <TableChips tables={tables} />
            </Section>

            <Section label="書き出す内容">
              <div className="choice-grid cols-3">
                {MODES.map((m) => (
                  <ChoiceCard
                    key={m.mode}
                    name="export-mode"
                    checked={mode === m.mode}
                    onChange={() => setMode(m.mode)}
                    icon={m.icon}
                    title={m.title}
                    desc={m.desc}
                  />
                ))}
              </div>
            </Section>

            <EngineSelect
              dbType={dbType}
              kind="export"
              engine={engine}
              onChange={setEngine}
            />

            <Section
              label="保存先とファイル名"
              extra={
                target.customized && (
                  <button className="tf-link" onClick={target.reset}>
                    既定に戻す
                  </button>
                )
              }
            >
              <div className={"tf-dest" + (patternError ? " invalid" : "")}>
                <button
                  className="tf-dest-folder has-tooltip tooltip-left"
                  data-tooltip={target.dir ? `フォルダを選ぶ\n${target.dir}` : "フォルダを選ぶ"}
                  onClick={target.pickDir}
                  disabled={!target.ready}
                  aria-label="保存するフォルダを選ぶ"
                >
                  {ICON_FOLDER}
                  <span className="tf-dest-folder-name">
                    {target.dir ? folderName(target.dir) : "…"}
                  </span>
                </button>
                <span className="tf-dest-sep" aria-hidden>
                  /
                </span>
                <input
                  ref={patternRef}
                  className="tf-dest-name mono"
                  value={target.pattern}
                  onChange={(e) => {
                    target.setPattern(e.target.value);
                    setOverwriteAsk(null);
                  }}
                  spellCheck={false}
                  aria-label="ファイル名のパターン"
                  placeholder={DEFAULT_NAME_PATTERN}
                />
              </div>
              <PatternTokens onInsert={insertToken} />
              <div className={"tf-dest-full mono" + (patternError ? " error" : "")}>
                {patternError ?? (preview && <>→ {preview}</>)}
              </div>
            </Section>
          </>
        )}

        {(error ?? target.loadError) && (
          <div className="result-banner ng">
            <span className="dot" aria-hidden />
            <strong>エラー</strong>
            <span className="result-detail">{error ?? target.loadError}</span>
          </div>
        )}
        {overwriteAsk && !running && (
          <div className="result-banner warn tf-overwrite">
            <span className="dot" aria-hidden />
            <span className="result-detail">
              同じ名前のファイル <strong className="mono">{splitPath(overwriteAsk).name}</strong>{" "}
              があります。書き出しが終わった時点で置き換わります。
            </span>
            <button className="btn-secondary" onClick={() => handleStart(true)}>
              上書きする
            </button>
          </div>
        )}
        {missing && (
          <ToolMissing tool={missing} onOpenSettings={onOpenSettings} />
        )}
        {job && <JobProgress job={job} kind="export" />}

        <div className="modal-actions">
          <span className="toolbar-spacer" />
          {running ? (
            <button
              className="btn-secondary"
              onClick={() =>
                cancelJob(job!.jobId).catch((e) =>
                  setError(`中止できませんでした: ${e}`)
                )
              }
            >
              中止する
            </button>
          ) : (
            <>
              <button className="btn-secondary" onClick={onClose}>
                閉じる
              </button>
              <button
                className="btn-primary"
                onClick={() => handleStart()}
                disabled={
                  tables.length === 0 || !!missing || checking || !target.ready || !!patternError
                }
                title={
                  missing
                    ? `${missing} が見つかりません`
                    : checking
                      ? "必要なコマンドを確認しています..."
                      : tables.length === 0
                        ? "表を1つ以上選んでください"
                        : patternError
                          ? patternError
                          : undefined
                }
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {job && !job.error ? "もう一度書き出す" : "書き出しを開始"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 流し込む対象のファイル */
interface PickedFile {
  path: string;
  name: string;
  size: number | null;
}

interface ImportProps {
  sessionId: string;
  database: string;
  connName: string;
  dbType: DbType;
  onClose: () => void;
  /** 設定画面を開く (外部ツールが見つからないとき) */
  onOpenSettings?: () => void;
  /** 実行に成功したあとテーブル一覧を更新する */
  onImported: () => void;
}

/** SQLファイルを流し込むダイアログ */
export function ImportDialog({
  sessionId,
  database,
  connName,
  dbType,
  onClose,
  onOpenSettings,
  onImported,
}: ImportProps) {
  const [file, setFile] = useState<PickedFile | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** D&Dファイルの転送進捗 (0〜1) */
  const [staging, setStaging] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { job, watch } = useJob();
  const [engine, setEngine] = useEngine(dbType);
  const { missing, checking } = useToolCheck(dbType, "import", engine);
  const notified = useRef(false);

  useEffect(() => {
    if (job && !job.running && !job.error && !notified.current) {
      notified.current = true;
      onImported();
    }
  }, [job, onImported]);

  const busy = job?.running || staging !== null;

  const pickFile = async () => {
    if (busy) return;
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "SQL", extensions: ["sql", "txt", "dump"] }],
      });
      if (typeof selected === "string") {
        // 区切りはOSによって違うので、両方から末尾を取る
        const name = selected.split(/[\\/]/).pop() ?? selected;
        setFile({ path: selected, name, size: null });
        setError(null);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    setError(null);
    setStaging(0);
    try {
      // ブラウザのFileからはパスが取れないため一時ファイルへ転送する
      const path = await stageDroppedFile(f, (done, total) =>
        setStaging(total > 0 ? done / total : 1)
      );
      setFile({ path, name: f.name, size: f.size });
    } catch (err) {
      setError(String(err));
    } finally {
      setStaging(null);
    }
  };

  const handleStart = async () => {
    if (!file) return;
    setError(null);
    notified.current = false;
    try {
      const started = await startImport(sessionId, database, file.path, engine);
      watch(started.jobId);
    } catch (e) {
      setError(String(e));
    }
  };


  // Escで閉じる・初期フォーカスは共通の作法にそろえる (実行中は閉じない)
  const boxRef = useModal(onClose, !job?.running);

  return (
    <div className="modal-overlay" onMouseDown={job?.running ? undefined : onClose}>
      <div
        className="modal transfer-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <TransferHead
          kind="import"
          title="SQLファイル実行"
          sub="SQLファイルの文を順に実行します (バックアップの復元など)"
          dbType={dbType}
          connName={connName}
          database={database}
          closeDisabled={job?.running}
          onClose={onClose}
        />

        <div className="result-banner warn import-warn">
          <span className="dot" aria-hidden />
          <span className="result-detail">
            <strong className="mono">
              {connName} / {database}
            </strong>{" "}
            に対してSQLを実行します。内容によっては既存データが変更・削除されます。
          </span>
        </div>

        <div
          className={
            "dropzone" +
            (dragOver ? " over" : "") +
            (file ? " has-file" : "") +
            (busy ? " busy" : "")
          }
          // ファイルを受け取る場所の印 (画面全体の落とし込み止めが避けて通る)
          data-file-drop=""
          onClick={pickFile}
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {staging !== null ? (
            <>
              <div className="job-bar dropzone-bar">
                <div
                  className="job-bar-fill"
                  style={{ width: `${Math.round(staging * 100)}%` }}
                />
              </div>
              <span className="dropzone-sub">
                ファイルを転送中... {Math.round(staging * 100)}%
              </span>
            </>
          ) : file ? (
            <>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M6 2h8l4 4v16H6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                <path d="M14 2v4h4" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                <path d="M9 13h6M9 17h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <span className="dropzone-file mono">{file.name}</span>
              {file.size !== null && (
                <span className="dropzone-sub mono">{fmtBytes(file.size)}</span>
              )}
              {!busy && (
                <button
                  className="dropzone-clear"
                  title="選択を解除"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFile(null);
                  }}
                >
                  ×
                </button>
              )}
            </>
          ) : (
            <>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <span className="dropzone-main">
                SQLファイルをここにドロップ
              </span>
              <span className="dropzone-sub">
                またはクリックして選択 (大きなファイルは、クリックして選ぶと転送を待たずに始められます)
              </span>
            </>
          )}
        </div>

        <EngineSelect
          dbType={dbType}
          kind="import"
          engine={engine}
          disabled={busy}
          onChange={setEngine}
        />

        {error && (
          <div className="result-banner ng">
            <span className="dot" aria-hidden />
            <strong>エラー</strong>
            <span className="result-detail">{error}</span>
          </div>
        )}
        {missing && (
          <ToolMissing tool={missing} onOpenSettings={onOpenSettings} />
        )}
        {job && <JobProgress job={job} kind="import" />}

        <div className="modal-actions">
          <span className="toolbar-spacer" />
          {job?.running ? (
            <button
              className="btn-secondary"
              onClick={() =>
                cancelJob(job.jobId).catch((e) =>
                  setError(`中止できませんでした: ${e}`)
                )
              }
            >
              キャンセル
            </button>
          ) : (
            <>
              <button className="btn-secondary" onClick={onClose}>
                閉じる
              </button>
              <button
                className="btn-primary"
                onClick={handleStart}
                disabled={!file || staging !== null || !!missing || checking}
                title={
                  missing
                    ? `${missing} が見つかりません`
                    : checking
                      ? "必要なコマンドを確認しています..."
                      : !file
                        ? "取り込むファイルを選んでください"
                        : staging !== null
                          ? "ファイルを準備しています..."
                          : undefined
                }
              >
                実行する
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
