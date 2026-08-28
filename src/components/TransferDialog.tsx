import { useEffect, useRef, useState } from "react";
import { useModal } from "../hooks/useModal";
import { open } from "@tauri-apps/plugin-dialog";
import {
  cancelJob,
  detectTools,
  jobStatus,
  startExport,
  startImport,
} from "../api";
import { stageDroppedFile } from "../uploadFile";
import { fmtBytes } from "../format";
import type { DbType, ExportMode, ExportTable } from "../types";

interface JobView {
  jobId: string;
  running: boolean;
  bytes: number;
  total: number | null;
  error: string | null;
  outPath: string | null;
}

/** ジョブの進捗をポーリングする共通フック */
function useJob() {
  const [job, setJob] = useState<JobView | null>(null);
  const timer = useRef<number | null>(null);

  const stop = () => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  };

  const watch = (jobId: string) => {
    stop();
    timer.current = window.setInterval(async () => {
      try {
        const s = await jobStatus(jobId);
        setJob({
          jobId,
          running: s.running,
          bytes: s.bytes,
          total: s.total,
          error: s.error,
          outPath: s.outPath,
        });
        if (!s.running) stop();
      } catch {
        stop();
      }
    }, 400);
    setJob({ jobId, running: true, bytes: 0, total: null, error: null, outPath: null });
  };

  useEffect(() => stop, []);
  return { job, setJob, watch };
}

function JobProgress({ job }: { job: JobView }) {
  const pct =
    job.total && job.total > 0
      ? Math.min(100, Math.round((job.bytes / job.total) * 100))
      : null;
  return (
    <div className="job-progress">
      {job.running ? (
        <>
          <div className="job-bar">
            <div
              className={"job-bar-fill" + (pct === null ? " indeterminate" : "")}
              style={pct !== null ? { width: `${pct}%` } : undefined}
            />
          </div>
          <span className="job-bytes mono">
            {fmtBytes(job.bytes)}
            {job.total ? ` / ${fmtBytes(job.total)} (${pct}%)` : ""}
          </span>
        </>
      ) : job.error ? (
        <div className="result-banner ng">
          <span className="dot" aria-hidden />
          <strong>失敗</strong>
          <span className="result-detail">{job.error}</span>
        </div>
      ) : (
        <div className="result-banner ok">
          <span className="dot" aria-hidden />
          <strong>完了</strong>
          <span className="result-detail mono">
            {fmtBytes(job.bytes)}
            {job.outPath ? ` → ${job.outPath}` : ""}
          </span>
        </div>
      )}
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
function useToolCheck(dbType: DbType, kind: "export" | "import") {
  const [missing, setMissing] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    const need =
      dbType === "mysql"
        ? kind === "export"
          ? "mysqldump"
          : "mysql"
        : kind === "export"
          ? "pg_dump"
          : "psql";
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
  }, [dbType, kind]);
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
  const { missing, checking } = useToolCheck(dbType, "export");

  const handleStart = async () => {
    setError(null);
    try {
      const started = await startExport(sessionId, database, tables, mode);
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
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">SQLダンプ出力</span>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={job?.running}
            title="閉じる"
          >
            ×
          </button>
        </div>

        <div className="transfer-summary">
          <span className="transfer-target mono">
            {connName} / {database}
          </span>
          <span className="transfer-tables">
            {tables.length}テーブル: {tables.map(tableLabel).join(", ")}
          </span>
        </div>

        <div className="mode-select">
          {(
            [
              ["full", "スキーマ + データ"],
              ["schema", "スキーマのみ"],
              ["data", "データのみ"],
            ] as const
          ).map(([m, label]) => (
            <label className="mode-option" key={m}>
              <input
                type="radio"
                name="export-mode"
                checked={mode === m}
                disabled={job?.running}
                onChange={() => setMode(m)}
              />
              {label}
            </label>
          ))}
        </div>

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
        {job && <JobProgress job={job} />}

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
                disabled={tables.length === 0 || !!missing || checking}
                title={
                  missing
                    ? `${missing} が見つかりません`
                    : checking
                      ? "必要なコマンドを確認しています..."
                      : tables.length === 0
                        ? "表を1つ以上選んでください"
                        : undefined
                }
              >
                {job && !job.error ? "再実行" : "出力を開始"}
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
  const { missing, checking } = useToolCheck(dbType, "import");
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
      const started = await startImport(sessionId, database, file.path);
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
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">SQLファイル実行</span>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={job?.running}
            title="閉じる"
          >
            ×
          </button>
        </div>

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
              <span className="dropzone-sub">またはクリックして選択</span>
            </>
          )}
        </div>

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
        {job && <JobProgress job={job} />}

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
