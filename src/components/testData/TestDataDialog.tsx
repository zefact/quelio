import { useCallback, useEffect, useState } from "react";
import { generateTestData, planTestData } from "../../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { DialogWhere } from "../DialogWhere";
import { JobProgress } from "../JobProgress";
import { ModalFrame } from "../ModalFrame";
import { SelectMenu } from "../SelectMenu";
import { testDataText } from "../../prodConfirm";
import { TestDataColumnList } from "./TestDataColumnList";
import type { FieldKind, TestDataColumn } from "../../types";

/** 進捗の取得・中止に使うIDを作る */
function newJobId(): string {
  return `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 作れる行数の選択肢 */
const ROW_CHOICES = [10, 100, 1000, 10000, 100000];

/** NULLにする割合の選択肢 (%) */
const NULL_CHOICES = [0, 5, 10, 30, 50];

interface Props {
  sessionId: string;
  database: string;
  /** PostgreSQLのスキーマ (他のDBはundefined) */
  schema?: string;
  table: string;
  /** 接続名 (見出しの下に出す) */
  connName?: string;
  /** 本番の接続か (見出しにバッジを出し、入れる前に確認する) */
  prod?: boolean;
  onClose: () => void;
  /** 生成が終わったあと一覧を更新する */
  onGenerated: () => void;
}

/**
 * 日本語のテストデータを作ってテーブルへ入れる画面。
 *
 * 列ごとの「何を入れるか」はバックエンドが論理名・カラム名・型から推測し、
 * ここで選び直せる。自動採番の列と、選ばなかった列には何も入れない
 * (既定値・NULLがそのまま使われる)
 */
export function TestDataDialog({
  sessionId,
  database,
  schema,
  table,
  connName,
  prod = false,
  onClose,
  onGenerated,
}: Props) {
  /** 列ごとの案 (読み込み前はnull) */
  const [plan, setPlan] = useState<TestDataColumn[] | null>(null);
  /** 入れる列 (カラム名) */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** 選び直した種類 (カラム名 → 種類) */
  const [kinds, setKinds] = useState<Record<string, FieldKind>>({});
  const [rows, setRows] = useState(100);
  const [nullRate, setNullRate] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  /** 作り終えたか (中止・失敗は除く)。終わったら主ボタンを「閉じる」にする */
  const [done, setDone] = useState(false);
  /** 実行中のジョブ (未実行はnull) */
  const [job, setJob] = useState<{ id: string; startedAt: number } | null>(
    null
  );
  /** 本番で、入れる前の確認を出しているか */
  const [asking, setAsking] = useState(false);

  const busy = !!job;
  const label = schema ? `${schema}.${table}` : table;

  // 列の案を取る。自動採番以外を既定で選んでおく
  useEffect(() => {
    let alive = true;
    planTestData(sessionId, database, schema, table)
      .then((list) => {
        if (!alive) return;
        setPlan(list);
        setPicked(
          new Set(list.filter((c) => !c.auto).map((c) => c.name))
        );
      })
      .catch((e) => {
        if (alive) setError(`テーブルの定義を取得できません: ${e}`);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, database, schema, table]);

  const toggle = useCallback((name: string) => {
    setPicked((cur) => {
      const next = new Set(cur);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }, []);

  const changeKind = useCallback((name: string, kind: FieldKind) => {
    setKinds((cur) => ({ ...cur, [name]: kind }));
  }, []);

  const columns = (plan ?? []).filter((c) => picked.has(c.name));
  const canRun = !!plan && columns.length > 0 && !busy;

  /** 「作成する」を押したとき。本番では先に確認を出す */
  const askRun = () => {
    if (!canRun) return;
    if (prod) setAsking(true);
    else void run();
  };

  const run = async () => {
    if (!canRun) return;
    const started = { id: newJobId(), startedAt: Date.now() };
    setJob(started);
    setError(null);
    setResult(null);
    setDone(false);
    try {
      const r = await generateTestData(
        sessionId,
        database,
        schema,
        table,
        rows,
        nullRate,
        columns.map((c) => ({ name: c.name, kind: kinds[c.name] ?? c.kind })),
        started.id
      );
      if (r.cancelled) {
        setResult("生成を中止しました (何も入っていません)");
      } else {
        setResult(`${r.rows.toLocaleString()}行を作成しました`);
        setDone(true);
        onGenerated();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setJob(null);
    }
  };

  return (
    // 実行中・確認中は Esc・背景クリック・× で閉じない
    <ModalFrame
      title="テストデータを作成"
      target={label}
      prod={prod}
      onClose={onClose}
      closable={!busy && !asking}
      className="csv-import-modal"
      footerNote={
        !job &&
        "1つのトランザクションで入れます。失敗・中止したときは何も入りません"
      }
      footer={
        job ? (
          <JobProgress
            jobId={job.id}
            startedAt={job.startedAt}
            verb="生成"
            unit="行"
            // 作る行数は決まっているので、進み具合の帯を出す
            total={rows}
            className="job-progress-inline"
            onError={setError}
          />
        ) : (
          <>
            <button
              className="btn-secondary"
              onClick={done ? () => void askRun() : onClose}
              disabled={done && !canRun}
            >
              {done ? "続けて作成する" : "キャンセル"}
            </button>
            {done ? (
              <button className="btn-primary" onClick={onClose}>
                閉じる
              </button>
            ) : (
              <button
                className="btn-primary has-tooltip"
                disabled={!canRun}
                data-tooltip={
                  columns.length === 0 ? "入れる列を選んでください" : undefined
                }
                onClick={askRun}
              >
                {rows.toLocaleString()}行を作成する
              </button>
            )}
          </>
        )
      }
    >
      <DialogWhere connName={connName} database={database} />

      <div className="gen-settings">
        <label className="gen-field">
          <span className="gen-label">行数</span>
          <SelectMenu
            value={String(rows)}
            options={ROW_CHOICES.map((n) => ({
              value: String(n),
              label: `${n.toLocaleString()}行`,
            }))}
            onChange={(v) => {
              setRows(Number(v));
              setDone(false);
            }}
            disabled={busy}
          />
        </label>
        <label className="gen-field">
          <span className="gen-label">NULLの割合</span>
          <SelectMenu
            value={String(nullRate)}
            options={NULL_CHOICES.map((n) => ({
              value: String(n),
              label: n === 0 ? "入れない" : `${n}%`,
            }))}
            onChange={(v) => setNullRate(Number(v))}
            disabled={busy}
          />
        </label>
        <span className="gen-hint faint">
          NULLが入るのは「NULL可・重複してよい」列だけです。
          外部キーの列は参照先にある値から選びます
        </span>
      </div>

      {error && (
        <div className="result-banner ng">
          <span className="dot" aria-hidden />
          <strong>エラー</strong>
          <span className="result-detail">{error}</span>
        </div>
      )}
      {result && (
        <div className={"result-banner " + (done ? "ok" : "warn")}>
          <span className="dot" aria-hidden />
          <span className="result-detail">{result}</span>
        </div>
      )}

      <div className="csv-import-body">
        {!plan ? (
          <div className="routine-empty">
            <span className="spinner accent" /> 読み込み中…
          </div>
        ) : (
          <TestDataColumnList
            columns={plan}
            picked={picked}
            kinds={kinds}
            disabled={busy}
            onToggle={toggle}
            onChangeKind={changeKind}
          />
        )}
      </div>

      {asking && (
        <ConfirmDialog
          title="テストデータを入れます"
          target={label}
          confirmLabel={`${rows.toLocaleString()}行を作成する`}
          tone="primary"
          prodNote={testDataText(label, rows)}
          onConfirm={() => {
            setAsking(false);
            void run();
          }}
          onCancel={() => setAsking(false)}
        >
          作った行は、このテーブルにそのまま残ります。
        </ConfirmDialog>
      )}
    </ModalFrame>
  );
}
