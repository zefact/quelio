import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  appendTempUpload,
  cancelJob,
  createTempUpload,
  jobStatus,
  startExport,
  startImport,
} from "../api";
import type { ExportMode } from "../types";

/** バイト数の表示 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

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
  tables: string[];
  onClose: () => void;
}

/** 選択テーブルのエクスポートダイアログ */
export function ExportDialog({
  sessionId,
  database,
  connName,
  tables,
  onClose,
}: ExportProps) {
  const [mode, setMode] = useState<ExportMode>("full");
  const [error, setError] = useState<string | null>(null);
  const { job, watch } = useJob();

  const handleStart = async () => {
    setError(null);
    try {
      const started = await startExport(sessionId, database, tables, mode);
      watch(started.jobId);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={job?.running ? undefined : onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">エクスポート</span>
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
            {tables.length}テーブル: {tables.join(", ")}
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
        {job && <JobProgress job={job} />}

        <div className="modal-actions">
          <span className="toolbar-spacer" />
          {job?.running ? (
            <button
              className="btn-secondary"
              onClick={() => cancelJob(job.jobId).catch(() => {})}
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
                disabled={tables.length === 0}
              >
                {job && !job.error ? "再実行" : "エクスポート開始"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** ArrayBuffer → base64 */
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** D&DされたFileを一時ファイルへ転送してパスを返す */
async function stageDroppedFile(
  f: File,
  onProgress: (done: number, total: number) => void
): Promise<string> {
  const path = await createTempUpload(f.name);
  const CHUNK = 4 * 1024 * 1024;
  for (let off = 0; off < f.size; off += CHUNK) {
    const buf = await f.slice(off, off + CHUNK).arrayBuffer();
    await appendTempUpload(path, bufToBase64(buf));
    onProgress(Math.min(off + CHUNK, f.size), f.size);
  }
  return path;
}

/** インポート対象ファイル */
interface PickedFile {
  path: string;
  name: string;
  size: number | null;
}

interface ImportProps {
  sessionId: string;
  database: string;
  connName: string;
  onClose: () => void;
  /** インポート成功後にテーブル一覧を更新する */
  onImported: () => void;
}

/** SQLファイルのインポートダイアログ */
export function ImportDialog({
  sessionId,
  database,
  connName,
  onClose,
  onImported,
}: ImportProps) {
  const [file, setFile] = useState<PickedFile | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** D&Dファイルの転送進捗 (0〜1) */
  const [staging, setStaging] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { job, watch } = useJob();
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
    const selected = await open({
      multiple: false,
      filters: [{ name: "SQL", extensions: ["sql", "txt", "dump"] }],
    });
    if (typeof selected === "string") {
      const name = selected.split("/").pop() ?? selected;
      setFile({ path: selected, name, size: null });
      setError(null);
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

  return (
    <div className="modal-overlay" onMouseDown={job?.running ? undefined : onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">インポート (SQLファイル実行)</span>
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
        {job && <JobProgress job={job} />}

        <div className="modal-actions">
          <span className="toolbar-spacer" />
          {job?.running ? (
            <button
              className="btn-secondary"
              onClick={() => cancelJob(job.jobId).catch(() => {})}
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
                disabled={!file || staging !== null}
              >
                インポート実行
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
