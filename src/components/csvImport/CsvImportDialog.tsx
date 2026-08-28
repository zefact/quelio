import { useEffect, useRef, useState } from "react";
import { cancelCsvExport, importCsv, previewCsv, tableDetail } from "../../api";
import { useModal } from "../../hooks/useModal";
import { CsvProgress } from "../CsvProgress";
import { CsvFilePicker, type PickedFile } from "./CsvFilePicker";
import { CsvMapping } from "./CsvMapping";
import { CsvSettings } from "./CsvSettings";
import { autoMap, checkMapping } from "./mapping";
import type {
  ColumnInfo,
  CsvOptions,
  CsvPreview,
  DbType,
  ImportMode,
} from "../../types";

/** 進捗の取得・中止に使うIDを作る */
function newJobId(): string {
  return `csvin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface Props {
  sessionId: string;
  database: string;
  /** PostgreSQLのスキーマ (他のDBはundefined) */
  schema?: string;
  table: string;
  /** 列の見方がDBごとに違うので受け取る (自動採番の判定など) */
  dbType: DbType;
  onClose: () => void;
  /** 取り込みが終わったあと一覧を更新する */
  onImported: () => void;
}

/**
 * CSV / TSVファイルをテーブルへ取り込むダイアログ。
 *
 * ファイルを選ぶ → 先頭を見ながら列の対応を決める → 取り込む、の順に進む。
 * 取り込みはバックエンドでトランザクションに包んであるので、
 * 途中で失敗・中止しても半端に入ることはない
 */
export function CsvImportDialog({
  sessionId,
  database,
  schema,
  table,
  dbType,
  onClose,
  onImported,
}: Props) {
  const [file, setFile] = useState<PickedFile | null>(null);
  const [options, setOptions] = useState<CsvOptions>({ hasHeader: true });
  const [mode, setMode] = useState<ImportMode>("append");
  const [emptyAsNull, setEmptyAsNull] = useState(true);

  /** 取り込み先テーブルの列 (読み込み前はnull) */
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  /**
   * 読み取った先頭の内容と、そのとき使った「1行目は見出し」の設定。
   * 設定を変えた直後に、古い内容へ新しい設定を当ててしまわないよう対にして持つ
   */
  const [preview, setPreview] = useState<{
    data: CsvPreview;
    hasHeader: boolean;
  } | null>(null);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  /** 実行中のジョブ (未実行はnull) */
  const [job, setJob] = useState<{ id: string; startedAt: number } | null>(
    null
  );
  /** 中止を要求済みか (二重に押させない) */
  const [cancelling, setCancelling] = useState(false);
  /** D&Dしたファイルを転送中か (終わるまで取り込みを始めさせない) */
  const [staging, setStaging] = useState(false);
  /** 取り込み済みか (同じ内容を続けて2回入れてしまわないように) */
  const [imported, setImported] = useState(false);

  const busy = !!job || staging;

  // 実行中・転送中は Esc でもオーバーレイのクリックでも閉じない
  const boxRef = useModal(onClose, !busy);

  // 取り込み先の列を取得する (画面から来た名前ではなく、実際の定義を使う)
  useEffect(() => {
    let alive = true;
    tableDetail(sessionId, database, schema, table)
      .then((d) => {
        if (alive) setColumns(d.columns);
      })
      .catch((e) => {
        if (alive) setError(`テーブルの定義を取得できません: ${e}`);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, database, schema, table]);

  /**
   * 先頭だけ読み直す。
   * 設定を続けて変えたときに、古い結果で上書きしないよう番号で見分ける
   */
  const previewSeq = useRef(0);
  useEffect(() => {
    // 番号を進めてから始める (解除したときも、走っている取得の結果を捨てる)
    const seq = ++previewSeq.current;
    if (!file) {
      setPreview(null);
      setLoading(false);
      return;
    }
    const hasHeader = options.hasHeader;
    setLoading(true);
    previewCsv(file.path, options)
      .then((p) => {
        if (seq !== previewSeq.current) return;
        setPreview({ data: p, hasHeader });
        setError(null);
      })
      .catch((e) => {
        if (seq !== previewSeq.current) return;
        setPreview(null);
        setError(String(e));
      })
      .finally(() => {
        if (seq === previewSeq.current) setLoading(false);
      });
    // 画面から離れたら結果を捨てる
    return () => {
      previewSeq.current++;
    };
  }, [file, options]);

  /**
   * 自動で割り当てたときの「ファイルと列の並び」。
   * これが変わらないうちは、手で直した対応を上書きしない
   */
  const mappedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!preview || !columns) {
      setMapping([]);
      mappedFor.current = null;
      return;
    }
    // 読み取り直しても列が同じなら、手で直した対応をそのまま残す
    const sig = [
      schema ?? "",
      table,
      file?.path ?? "",
      String(preview.hasHeader),
      // 取り込み先の列は後から届くので、それも目印に入れる
      "\u0001",
      ...columns.map((c) => c.name),
      // 個数が変わる並びが続くので、区切りの印を挟む
      "\u0002",
      ...preview.data.columns,
    ].join("\u0000");
    if (sig === mappedFor.current) return;
    mappedFor.current = sig;
    setMapping(
      autoMap(
        preview.data.columns,
        columns.map((c) => c.name),
        preview.hasHeader
      )
    );
  }, [preview, columns, file, schema, table]);

  /* 読み取り直した直後の1描画だけ、前のファイルの長さが残ることがある */
  const sized =
    preview && mapping.length === preview.data.columns.length ? mapping : null;
  const issues =
    sized && columns && sized.length > 0
      ? checkMapping(sized, columns, mode, dbType)
      : [];
  const blocked = issues.some((i) => i.level === "error");
  const canRun =
    !!file && !!sized && sized.length > 0 && !!columns && !loading && !busy;

  const run = async () => {
    if (!canRun || blocked || imported || !file) return;
    const pairs: [number, string][] = [];
    mapping.forEach((m, i) => {
      if (m !== null) pairs.push([i, m]);
    });
    const started = { id: newJobId(), startedAt: Date.now() };
    setJob(started);
    setCancelling(false);
    setError(null);
    setResult(null);
    try {
      const r = await importCsv(
        sessionId,
        database,
        schema,
        table,
        file.path,
        options,
        pairs,
        mode,
        emptyAsNull,
        started.id
      );
      if (r.cancelled) {
        setResult("取り込みを中止しました (何も取り込んでいません)");
      } else {
        setResult(`${r.rows.toLocaleString()}行を取り込みました`);
        setImported(true);
        onImported();
        /*
         * D&Dで預けたファイルは、取り込みに成功するとバックエンドが消す。
         * 消えたファイルのまま実行し直せないよう選択を外す
         * (中止・失敗のときは残るので、選択はそのままにする)
         */
        if (file.staged) setFile(null);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setJob(null);
      setCancelling(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal csv-import-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            CSVを取り込む
            <span className="column-modal-target mono">
              {schema ? `${schema}.${table}` : table}
            </span>
          </span>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={busy}
            title={busy ? "処理中は閉じられません" : "閉じる (Esc)"}
          >
            ×
          </button>
        </div>

        <CsvFilePicker
          file={file}
          onFile={(f) => {
            setFile(f);
            setResult(null);
            setError(null);
            setImported(false);
          }}
          onError={setError}
          disabled={!!job}
          onBusyChange={setStaging}
        />

        <CsvSettings
          options={options}
          onOptions={(next) => {
            setOptions(next);
            setImported(false);
          }}
          mode={mode}
          onMode={(next) => {
            setMode(next);
            setImported(false);
          }}
          emptyAsNull={emptyAsNull}
          onEmptyAsNull={(next) => {
            setEmptyAsNull(next);
            setImported(false);
          }}
          detected={
            preview
              ? {
                  delimiter: preview.data.delimiter,
                  encoding: preview.data.encoding,
                }
              : null
          }
          disabled={busy}
          readDisabled={busy || !file}
        />

        {preview?.data.warning && (
          <div className="result-banner warn">
            <span className="dot" aria-hidden />
            <span className="result-detail">{preview.data.warning}</span>
          </div>
        )}
        {issues.map((i, at) => (
          <div
            key={at}
            className={
              i.level === "error" ? "result-banner ng" : "result-banner warn"
            }
          >
            <span className="dot" aria-hidden />
            <span className="result-detail">{i.message}</span>
          </div>
        ))}
        {error && (
          <div className="result-banner ng">
            <span className="dot" aria-hidden />
            <strong>エラー</strong>
            <span className="result-detail">{error}</span>
          </div>
        )}
        {result && (
          <div className="result-banner ok">
            <span className="dot" aria-hidden />
            <span className="result-detail">{result}</span>
          </div>
        )}

        <div className="csv-import-body">
          {loading ? (
            <div className="routine-empty">
              <span className="spinner accent" /> 読み込み中...
            </div>
          ) : preview && columns ? (
            <CsvMapping
              preview={preview.data}
              targets={columns}
              mapping={mapping}
              onChange={(i, target) => {
                setMapping((cur) => cur.map((m, at) => (at === i ? target : m)));
                setImported(false);
              }}
              disabled={!!job}
            />
          ) : (
            <div className="routine-empty">
              ファイルを選ぶと、先頭の内容と列の対応が表示されます
            </div>
          )}
        </div>

        <div className="modal-actions">
          {job ? (
            <>
              <CsvProgress
                jobId={job.id}
                startedAt={job.startedAt}
                verb="取り込み"
              />
              <button
                className="btn-secondary"
                disabled={cancelling}
                onClick={() => {
                  setCancelling(true);
                  cancelCsvExport(job.id).catch((e) => {
                    setCancelling(false);
                    setError(`中止できませんでした: ${e}`);
                  });
                }}
              >
                {cancelling ? "中止しています..." : "中止"}
              </button>
            </>
          ) : (
            <>
              <span className="csv-import-hint faint">
                取り込みは1つのトランザクションで行います。失敗・中止したときは何も入りません
              </span>
              <button className="btn-secondary" onClick={onClose} disabled={busy}>
                閉じる
              </button>
              <button
                className="btn-primary"
                disabled={!canRun || blocked || imported}
                title={
                  imported
                    ? "同じ内容を続けて入れないよう、いったん止めています (ファイルか設定を変えると押せます)"
                    : undefined
                }
                onClick={run}
              >
                取り込む
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
